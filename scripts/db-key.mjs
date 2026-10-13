/**
 * Join key for a database. The two upstream sources mint different ids for the
 * same database, but both resolve it to the same URL — squigsites via `urlType` +
 * folder, the aggregate index by stripping the filename off `phoneBookUrl` — so
 * the URL is what actually identifies it. Normalized to one trailing slash,
 * lowercase host, no query or fragment.
 *
 * Shared by the index build (to merge the sources) and the health tracker (to
 * follow a database across days even when its id flips between sources).
 */
export function dbKey(url) {
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
