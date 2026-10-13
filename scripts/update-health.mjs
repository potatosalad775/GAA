// Tracks the health of every database in db-site-index.json across days, and
// once a month writes a digest of it to HEALTH.md.
//
// The index itself is rebuilt from scratch every day and says only whether a
// database is reachable *today*. That can't tell a site that blipped for a day
// apart from one that has been dead since spring. This script keeps the missing
// history in data/site-health.json, which is committed to the repo:
//
//   - when each database was first seen,
//   - since when it has been unverified, if it currently is,
//   - this month's events: databases added, removed, gone unreachable, recovered.
//
// The state file is written only when one of those actually changes, and it
// stores dates of transitions rather than "last checked" stamps, so a quiet day
// produces no diff and no commit. On the first run of a new month the previous
// month's events are rendered into HEALTH.md and cleared. That guarantees at
// least one commit a month, which also keeps GitHub from disabling the
// scheduled workflow for inactivity.
//
// Usage:
//   node scripts/update-health.mjs [--index dist/db-site-index.json]
//     [--state data/site-health.json] [--digest HEALTH.md]
//     [--commit-message <path>] [--today YYYY-MM-DD]
//
// Writes nothing and exits 0 when there is nothing to record. With
// --commit-message, also writes a one-line summary for the commit to that path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbKey } from './db-key.mjs';

const STATE_VERSION = 1;

/** Unverified this long and a database makes the digest's "long-term unreachable" list. */
const LONG_TERM_DAYS = 30;

/**
 * More databases than this vanishing in one run is far more likely an upstream
 * glitch than a mass exodus. Refuse rather than erase their history; a human can
 * look and rerun.
 */
const MAX_REMOVED_FRACTION = 0.25;
const MAX_REMOVED_FLOOR = 10;

const argv = process.argv.slice(2);
function arg(name, dflt) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : dflt;
}
const INDEX = arg('--index', 'dist/db-site-index.json');
const STATE = arg('--state', 'data/site-health.json');
const DIGEST = arg('--digest', 'HEALTH.md');
const COMMIT_MESSAGE = arg('--commit-message', null);
const TODAY = arg('--today', new Date().toISOString().slice(0, 10));

if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) {
	console.error(`--today must be YYYY-MM-DD, got ${TODAY}`);
	process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const month = (date) => date.slice(0, 7);

function daysBetween(from, to) {
	return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Site names are third-party text going into Markdown; keep them inert. */
function md(text) {
	return String(text).replace(/[\\`*_[\]<>|#]/g, (c) => '\\' + c);
}

function label(record) {
	return `${record.siteName} (${record.type})`;
}

function plural(n, word) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ── Load ────────────────────────────────────────────────────────────────────

const index = JSON.parse(readFileSync(INDEX, 'utf8'));
const siteNames = new Map(index.sites.map((site) => [site.id, site.name]));

/** Today's view of every database, keyed the same way the build merges them. */
const current = new Map();
for (const db of index.dbs) {
	const key = dbKey(db.url);
	if (!key) continue;
	current.set(key, {
		id: db.id,
		siteName: siteNames.get(db.siteId) ?? db.siteId,
		type: db.type,
		url: db.url,
		verified: db.verified === true
	});
}

if (current.size === 0) {
	console.error(`${INDEX} lists no databases; refusing to record that.`);
	process.exit(1);
}

const bootstrap = !existsSync(STATE);
const state = bootstrap
	? { v: STATE_VERSION, trackingSince: TODAY, lastDigest: null, events: [], dbs: {} }
	: JSON.parse(readFileSync(STATE, 'utf8'));
const before = JSON.stringify(state);

// ── Monthly digest ──────────────────────────────────────────────────────────
//
// Rendered *before* today's changes are applied, so it describes the month that
// just ended and today's events open the new one.

function renderDigest({ title, period }) {
	const records = Object.values(state.dbs);
	const unverified = records.filter((r) => r.unverifiedSince);
	const longTerm = unverified
		.map((r) => ({ ...r, days: daysBetween(r.unverifiedSince, TODAY) }))
		.filter((r) => r.days >= LONG_TERM_DAYS)
		.sort((a, b) => b.days - a.days || a.siteName.localeCompare(b.siteName));
	const sites = new Set(records.map((r) => r.siteName));

	const byKind = (kind) => state.events.filter((e) => e.kind === kind);
	const added = byKind('added');
	const removed = byKind('removed');
	const wentDown = byKind('unreachable');
	const recovered = byKind('recovered');

	// A database that changed state three or more times in a month is flaky
	// rather than down; worth flagging separately from both lists above.
	const flips = new Map();
	for (const e of [...wentDown, ...recovered]) flips.set(e.key, (flips.get(e.key) ?? 0) + 1);
	const flaky = [...flips].filter(([, n]) => n >= 3);

	const lines = [
		`# ${title}`,
		'',
		`_Generated ${TODAY} by the scheduled workflow. ${period}_`,
		'',
		'## Snapshot',
		'',
		`- **${sites.size}** sites, **${records.length}** databases`,
		`- **${records.length - unverified.length}** verified, **${unverified.length}** unverified`,
		`- **${longTerm.length}** unverified for ${LONG_TERM_DAYS}+ days`,
		''
	];

	if (state.lastDigest !== null) {
		lines.push(
			'## This month',
			'',
			`- ${plural(added.length, 'database')} added, ${removed.length} removed`,
			`- ${wentDown.length} went unreachable, ${recovered.length} recovered`,
			''
		);
		const list = (heading, events) => {
			if (events.length === 0) return;
			lines.push(`### ${heading}`, '');
			for (const e of events) lines.push(`- ${e.date} — ${md(e.label)} — <${e.url}>`);
			lines.push('');
		};
		list('Added', added);
		list('Removed', removed);
		if (flaky.length) {
			lines.push('### Flaky', '', 'Changed state three or more times this month.', '');
			for (const [key, n] of flaky) {
				const r = state.dbs[key];
				lines.push(`- ${md(r ? label(r) : key)} — ${n} changes — <${key}>`);
			}
			lines.push('');
		}
	}

	lines.push(`## Unreachable for ${LONG_TERM_DAYS}+ days`, '');
	if (longTerm.length === 0) {
		lines.push('None.', '');
	} else {
		const sinceNote =
			state.trackingSince === TODAY
				? ''
				: `Days are counted from the first failed check since tracking began on ${state.trackingSince}. `;
		lines.push(
			`${sinceNote}These are registered upstream but have not been reachable by GraphAggregator for over a month — candidates for cleanup at the source.`,
			'',
			'| Site | Type | Unverified since | Days | URL |',
			'| --- | --- | --- | ---: | --- |'
		);
		for (const r of longTerm) {
			lines.push(`| ${md(r.siteName)} | ${md(r.type)} | ${r.unverifiedSince} | ${r.days} | <${r.url}> |`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

let digest = null;
if (!bootstrap && state.lastDigest !== month(TODAY)) {
	const covered = state.lastDigest ?? month(state.trackingSince);
	digest = {
		month: covered,
		text: renderDigest({
			title: `Registry health — ${covered}`,
			period: `Covers events from ${covered} and the state as of ${TODAY}.`
		})
	};
	state.events = [];
	state.lastDigest = month(TODAY);
}

// ── Apply today's view ──────────────────────────────────────────────────────

const removedKeys = Object.keys(state.dbs).filter((key) => !current.has(key));
const removeLimit = Math.max(MAX_REMOVED_FLOOR, Math.floor(Object.keys(state.dbs).length * MAX_REMOVED_FRACTION));
if (removedKeys.length > removeLimit) {
	console.error(
		`${removedKeys.length} databases disappeared since the last run (limit ${removeLimit}). ` +
			'That looks like an upstream glitch, not real removals; not recording it.'
	);
	process.exit(1);
}

const event = (kind, key, record) =>
	state.events.push({ date: TODAY, kind, key, label: label(record), url: record.url });

for (const key of removedKeys) {
	event('removed', key, state.dbs[key]);
	delete state.dbs[key];
}

for (const [key, db] of current) {
	const prev = state.dbs[key];
	const record = {
		id: db.id,
		siteName: db.siteName,
		type: db.type,
		url: db.url,
		firstSeen: prev?.firstSeen ?? TODAY,
		...(db.verified ? {} : { unverifiedSince: prev?.unverifiedSince ?? TODAY })
	};

	if (!prev) {
		if (!bootstrap) event('added', key, record);
	} else if (!db.verified && !prev.unverifiedSince) {
		event('unreachable', key, record);
	} else if (db.verified && prev.unverifiedSince) {
		event('recovered', key, record);
	}
	state.dbs[key] = record;
}

// Sorted keys so the committed file diffs cleanly day to day.
state.dbs = Object.fromEntries(Object.entries(state.dbs).sort(([a], [b]) => a.localeCompare(b)));

if (bootstrap) {
	state.lastDigest = month(TODAY);
	digest = {
		month: month(TODAY),
		text: renderDigest({
			title: 'Registry health',
			period: `Tracking started today; the first monthly digest replaces this on the 1st of next month.`
		})
	};
}

// ── Write ───────────────────────────────────────────────────────────────────

const after = JSON.stringify(state);
if (after === before && !digest) {
	console.error('No health changes today.');
	process.exit(0);
}

mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify(state, null, '\t') + '\n');
if (digest) writeFileSync(DIGEST, digest.text);

const todays = state.events.filter((e) => e.date === TODAY);
const count = (kind) => todays.filter((e) => e.kind === kind).length;
const parts = [
	count('added') && `${count('added')} added`,
	count('removed') && `${count('removed')} removed`,
	count('unreachable') && `${count('unreachable')} unreachable`,
	count('recovered') && `${count('recovered')} recovered`
].filter(Boolean);

const summary = bootstrap
	? `health: start tracking ${plural(current.size, 'database')}`
	: [
			digest && `health: digest for ${digest.month}`,
			parts.length && `${digest ? '' : 'health: '}${parts.join(', ')}`,
			!digest && !parts.length && 'health: update site metadata'
		]
			.filter(Boolean)
			.join('; ');

if (COMMIT_MESSAGE) writeFileSync(COMMIT_MESSAGE, summary + '\n');
console.error(summary);
for (const e of todays) console.error(`  ${e.kind}: ${e.label} — ${e.url}`);
