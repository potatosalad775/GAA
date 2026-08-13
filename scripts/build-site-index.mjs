// Builds db-site-index.json — a small directory of every known graph site and
// database, merged from two upstream documents:
//
//   1. GraphAggregator's aggregate-index.json — federated sites plus a mirror of
//      squigsites.json, with URLs already resolved and rig/deltaReady metadata.
//      Verification-gated: a database whose phone_book.json failed to fetch at
//      build time is absent entirely.
//   2. squig.link's squigsites.json — the live central registry. Registry-faithful:
//      it lists what operators registered, reachable or not.
//
// Neither source alone is right for a site picker. The aggregate index drops
// sites that happened to be down during its crawl, which would make them vanish
// from navigation for a day; squigsites.json knows nothing about federated sites
// and leaves URL construction to the client. So we union them, keyed on database
// URL, and mark each database `verified` according to whether the aggregate index
// vouched for it. Consumers can grey out the unverified ones instead of hiding
// them.
//
// Usage:
//   node scripts/build-site-index.mjs [--out dist/db-site-index.json]
//
// Both sources are required. If either is unreachable the script exits non-zero
// without writing, so a failed run leaves the previous deployment serving.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

/** Custom domain first, GitHub Pages mirror as backup — same order the client uses. */
const AGGREGATE_INDEX_URLS = [
	'https://graphaggregator.harutohiroki.com/aggregate-index.json',
	'https://harutohiroki.github.io/GraphAggregator/aggregate-index.json'
];

const SQUIGSITES_URL = 'https://squig.link/squigsites.json';

const SQUIGLINK_ROOT = 'https://squig.link';

const FETCH_TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
function arg(name, dflt) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : dflt;
}
const OUT = arg('--out', 'dist/db-site-index.json');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strips control bytes and caps length. Both inputs are third-party documents
 * assembled from hand-authored files, so a name can contain anything at all;
 * this output gets rendered straight into a dropdown.
 */
const CONTROL_CHARS = new RegExp('[\\x00-\\x1F\\x7F-\\x9F]', 'g');
function clean(value, max = 120) {
	if (typeof value !== 'string') return null;
	const trimmed = value.replace(CONTROL_CHARS, '').trim().slice(0, max);
	return trimmed.length ? trimmed : null;
}

/**
 * Join key for a database. The two sources mint different ids for the same
 * database, but both resolve it to the same URL — squigsites via `urlType` +
 * folder, the aggregate index by stripping the filename off `phoneBookUrl` —
 * so the URL is what actually identifies it. Normalized to one trailing slash,
 * lowercase host, no query or fragment.
 */
function dbKey(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

	const path = parsed.pathname.replace(/\/+$/, '') + '/';
	const port = parsed.port ? ':' + parsed.port : '';
	return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

async function fetchJson(url) {
	const res = await fetch(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

/** Tries each mirror in order, returning the first that answers with valid JSON. */
async function fetchFirst(urls, validate) {
	const failures = [];
	for (const url of urls) {
		try {
			const data = await fetchJson(url);
			if (!validate(data)) throw new Error('unexpected document shape');
			return { url, data };
		} catch (e) {
			failures.push(`${url}: ${e.message}`);
		}
	}
	throw new Error(failures.join('; '));
}

// ── Source 1: GraphAggregator aggregate-index.json ───────────────────────────

/**
 * Reads the aggregate index into per-database records. `phones` and `brands`
 * are the bulk of that document and irrelevant here — a site picker needs the
 * directory, not the 25k-device corpus.
 */
function readAggregateIndex(index) {
	const sitesById = new Map();
	for (const site of index.sites) {
		const id = clean(site?.id, 200);
		const name = clean(site?.name, 100);
		const url = clean(site?.url, 300);
		if (!id || !name || !url) continue;

		sitesById.set(id, {
			id,
			name,
			url,
			source: site.source === 'squigsites' ? 'squigsites' : 'federated',
			...(clean(site.github, 100) ? { github: clean(site.github, 100) } : {})
		});
	}

	const dbs = new Map();
	for (const db of index.dbs) {
		const site = sitesById.get(clean(db?.siteId, 200));
		const id = clean(db?.id, 300);
		const type = clean(db?.type, 40);
		const key = dbKey(db?.url);
		if (!site || !id || !type || !key) continue;

		const record = {
			db: {
				id,
				siteId: site.id,
				type,
				url: db.url,
				deltaReady: db.deltaReady === true,
				...(clean(db.rig, 60) ? { rig: clean(db.rig, 60) } : {})
			},
			site
		};

		// A site can appear both as a federated registry entry and as a squigsites
		// mirror. Distinct URLs in practice, but if they ever collide the federated
		// record is the operator's own registration, so it wins.
		const existing = dbs.get(key);
		if (existing && existing.site.source === 'federated') continue;
		dbs.set(key, record);
	}

	return { sitesById, dbs };
}

// ── Source 2: squig.link squigsites.json ─────────────────────────────────────

/** Resolves a squigsites entry to its base URL, mirroring the registry's own rules. */
function squigBaseUrl(site) {
	switch (site.urlType) {
		case 'root':
			return SQUIGLINK_ROOT;
		case 'altDomain':
			return clean(site.altDomain, 300) ?? `https://${site.username}.squig.link`;
		case 'labFolder':
			return `${SQUIGLINK_ROOT}/lab/${site.username}`;
		default:
			return `https://${site.username}.squig.link`;
	}
}

/** "/" → "root", "/headphones/" → "headphones". Used to disambiguate duplicate usernames. */
function folderSlug(folder) {
	const slug = String(folder ?? '')
		.replace(/^\/+|\/+$/g, '')
		.replace(/[^a-z0-9]+/gi, '-')
		.toLowerCase();
	return slug || 'root';
}

/**
 * Reads squigsites.json into the same per-database shape.
 *
 * A username normally appears once, but Earphones Archive registers twice — once
 * for its IEM folder and once for /headphones/ — so the username alone doesn't
 * identify a site. Duplicated usernames get the folder folded into the minted id,
 * matching what the aggregate index does, so ids stay stable across both sources.
 */
function readSquigsites(registry) {
	const usernameCounts = new Map();
	for (const site of registry) {
		const username = clean(site?.username, 100);
		if (username) usernameCounts.set(username, (usernameCounts.get(username) ?? 0) + 1);
	}

	const dbs = new Map();
	for (const site of registry) {
		const username = clean(site?.username, 100);
		const name = clean(site?.name, 100);
		if (!username || !name || !Array.isArray(site.dbs) || site.dbs.length === 0) continue;

		const base = squigBaseUrl(site);
		const duplicated = usernameCounts.get(username) > 1;
		const siteId = duplicated
			? `squigsites:${folderSlug(site.dbs[0]?.folder)}:${username}`
			: `squigsites:${username}`;

		const record = { id: siteId, name, url: base, source: 'squigsites' };

		for (const db of site.dbs) {
			const type = clean(db?.type, 40);
			if (!type) continue;

			const url = base + (typeof db.folder === 'string' && db.folder ? db.folder : '/');
			const key = dbKey(url);
			if (!key || dbs.has(key)) continue;

			dbs.set(key, {
				db: {
					id: `${siteId}:${type.toLowerCase()}`,
					siteId,
					type,
					url,
					deltaReady: db.deltaReady === true || db.deltaReady === 'true'
				},
				site: record
			});
		}
	}

	return dbs;
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Unions both sources. The aggregate index wins where both know a database — it
 * carries rig and a verified deltaReady, and its ids are what existing consumers
 * of the aggregator already use. Databases only squigsites knows about are kept
 * and marked `verified: false`: they are registered but were unreachable when the
 * aggregator last crawled, which is a reason to flag them, not to hide them.
 */
function merge(aggregate, squigsites) {
	const sites = new Map();
	const dbs = [];

	/** Lets a squigsites-only database reuse the aggregate index's id for its site. */
	const aggSiteIdByBaseUrl = new Map();
	for (const site of aggregate.sitesById.values()) {
		const key = dbKey(site.url);
		if (!key) continue;
		// Ambiguous when several sites share a base URL (the duplicate-username case);
		// record the clash so we mint a fresh id rather than guessing wrong.
		aggSiteIdByBaseUrl.set(key, aggSiteIdByBaseUrl.has(key) ? null : site);
	}

	for (const entry of aggregate.dbs.values()) {
		sites.set(entry.site.id, entry.site);
		dbs.push({ ...entry.db, verified: true });
	}

	for (const [key, entry] of squigsites) {
		if (aggregate.dbs.has(key)) continue;

		// Prefer the aggregate index's record for this site when it has one, so a
		// site with one reachable and one unreachable database stays a single entry.
		const baseKey = dbKey(entry.site.url);
		const adopted = baseKey ? aggSiteIdByBaseUrl.get(baseKey) : null;
		const site = adopted ?? entry.site;

		sites.set(site.id, site);
		dbs.push({ ...entry.db, siteId: site.id, verified: false });
	}

	// Stable order so the published document reads consistently and diffs cleanly
	// between runs.
	const siteList = [...sites.values()].sort(
		(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
	);
	const siteNameById = new Map(siteList.map((site) => [site.id, site.name]));
	dbs.sort(
		(a, b) =>
			(siteNameById.get(a.siteId) ?? '').localeCompare(siteNameById.get(b.siteId) ?? '') ||
			a.type.localeCompare(b.type) ||
			a.url.localeCompare(b.url)
	);

	return { sites: siteList, dbs };
}

// ── Build ────────────────────────────────────────────────────────────────────

const aggregateSource = await fetchFirst(
	AGGREGATE_INDEX_URLS,
	(data) => Array.isArray(data?.sites) && Array.isArray(data?.dbs)
).catch((e) => {
	console.error(`Could not read aggregate-index.json — ${e.message}`);
	process.exit(1);
});

const squigsitesSource = await fetchFirst([SQUIGSITES_URL], (data) => Array.isArray(data)).catch(
	(e) => {
		console.error(`Could not read squigsites.json — ${e.message}`);
		process.exit(1);
	}
);

const aggregate = readAggregateIndex(aggregateSource.data);
const squigsites = readSquigsites(squigsitesSource.data);
const { sites, dbs } = merge(aggregate, squigsites);

if (sites.length === 0 || dbs.length === 0) {
	console.error('Refusing to publish an empty index.');
	process.exit(1);
}

const fetchedAt = new Date().toISOString();
const out = {
	v: SCHEMA_VERSION,
	generatedAt: fetchedAt,
	sources: {
		aggregateIndex: {
			url: aggregateSource.url,
			// The aggregator's own build time — the real age of the federated data,
			// which is older than our `generatedAt` and is what staleness checks want.
			generatedAt: clean(aggregateSource.data.generatedAt, 40),
			fetchedAt
		},
		squigsites: { url: squigsitesSource.url, fetchedAt }
	},
	sites,
	dbs
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));

const unverified = dbs.filter((db) => !db.verified);
console.error(
	`Wrote ${OUT}: ${sites.length} sites, ${dbs.length} databases ` +
		`(${unverified.length} unverified), aggregate index generated ${out.sources.aggregateIndex.generatedAt}.`
);
for (const db of unverified) {
	console.error(`  unverified: ${db.id} — ${db.url}`);
}
