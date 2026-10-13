# GAA

`GAA` stands for `GraphAggregatorAggregator`.

It's a small directory of every known graph site and measurement database, rebuilt daily and published as a single JSON file:

```
https://potatosalad775.github.io/GAA/db-site-index.json
```

It exists so a graph tool can render a site picker — "which database am I looking at, and where else
can I go?" — without downloading a full device corpus or hard-coding squig.link's URL conventions.

## Wanna join the party?

If you run a graph site or measurement database, please register it with [GraphAggregator](https://graphaggregator.harutohiroki.com/). GAA will pick it up automatically.

If you run a squig.link site, please ask MRS to register your page within squig.link. GAA will pick it up automatically.

## Why it isn't just one upstream document

Two documents already describe this network, and neither is quite right on its own.

[**GraphAggregator**](https://github.com/HarutoHiroki/GraphAggregator)'s `aggregate-index.json` is
the better source: it covers federated sites as well as squig.link ones, resolves every database to
an absolute URL, and carries rig and delta-ready metadata. But it is ~360 KB gzipped, because 25,000
devices dominate it — a site picker only needs the fraction of that.

**squig.link**'s `squigsites.json` is registry-faithful — it lists what operators registered, up or
down — and it is tiny. But it knows nothing about federated sites, and it leaves URL construction
(`urlType`, `altDomain`, lab folders) to every client that reads it.

So GAA fetches both, unions them, and publishes the directory alone. Two HTTP requests per build,
no crawling of anyone's site.

## What the merge does

Databases are joined on their **URL**, not their id — the two sources mint different ids for the
same database, but both resolve it to the same address, so the URL is what actually identifies it.

- A database both sources know: the aggregate index's record wins (richer metadata, and its ids are
  what existing aggregator consumers already use), marked `"verified": true`.
- A database only `squigsites.json` knows: kept, marked `"verified": false`. It is registered but was
  unreachable when the aggregator last crawled. Grey it out; don't hide it.
- A site with one reachable and one unreachable database stays a **single** site entry — the
  unverified database adopts the aggregate index's site id rather than minting a parallel one.

Duplicate usernames are handled the way the aggregator handles them: Some registers
twice in `squigsites.json`, once per folder, so a duplicated username gets its folder folded into the
minted id.

## Output schema

```jsonc
{
  "v": 1,
  "generatedAt": "2026-08-13T08:00:00.000Z",
  "sources": {
    "aggregateIndex": {
      "url": "https://graphaggregator.harutohiroki.com/aggregate-index.json",
      "generatedAt": "2026-08-13T06:42:13.028Z", // the aggregator's build time
      "fetchedAt": "2026-08-13T08:00:00.000Z"
    },
    "squigsites": {
      "url": "https://squig.link/squigsites.json",
      "fetchedAt": "2026-08-13T08:00:00.000Z"
    }
  },
  "sites": [
    {
      "id": "squigsites:example",
      "name": "example",
      "url": "https://example.squig.link",
      "source": "squigsites", // or "federated" — registered directly with the aggregator
      "github": "..." // federated entries only
    }
  ],
  "dbs": [
    {
      "id": "squigsites:example:iems",
      "siteId": "squigsites:example",
      "type": "IEMs", // "IEMs" | "Headphones" | "Earbuds" | "5128" — free-form in practice
      "url": "https://example.squig.link/",
      "deltaReady": false,
      "verified": true,
      "rig": "..." // federated entries only
    }
  ]
}
```

Check `sources.aggregateIndex.generatedAt`, not `generatedAt`, when you care how old the federated
data actually is — ours is only the time we copied it.

Every `dbs[].url` is absolute and ends in a slash, so a share link is
`` `${db.url}?share=${encodeURIComponent(slug)}` ``.

## Freshness and failure

The build runs daily at **08:00 UTC**, deliberately after GraphAggregator's own 06:00 UTC rebuild, so
each run picks up that day's crawl rather than the previous day's. Worst-case age of federated data
is roughly one aggregator cycle plus two hours.

The index itself is never committed — it is built fresh and deployed straight to Pages.
Both sources are required: if either is unreachable, or the merge comes out empty, the build exits
non-zero without publishing and **the previous deployment keeps serving**. Stale beats empty for a
navigation menu.

## Registry health

The index only says whether a database is reachable *today*. To tell a one-day blip from a site
that has been gone for months, a second job keeps a running history in
[`data/site-health.json`](data/site-health.json): when each database was first seen, since when it
has been unverified, and this month's additions, removals, outages and recoveries.

That file is committed only when one of those changes — quiet days produce no commit. On the first
run of each month the previous month is summarised in [`HEALTH.md`](HEALTH.md), including every
database that has been unreachable for 30+ days: registered upstream, but likely dead, and worth
reporting to GraphAggregator or squig.link for cleanup.

The monthly digest commit also keeps GitHub from disabling the daily schedule after 60 days without
repository activity. The health job runs separately from the deploy, so if it fails, the index
still ships. If more than a quarter of known databases vanish in one run, it refuses to record
that as removals, on the assumption that something upstream broke.

## Running it locally

```sh
node scripts/build-site-index.mjs --out dist/db-site-index.json
```

Prints a summary and lists any unverified databases on stderr. To update the health history from
that build:

```sh
node scripts/update-health.mjs --index dist/db-site-index.json
```

## Self-hosting

Fork, enable Actions and set **Settings → Pages → Source** to *GitHub Actions*, then run the workflow
once from the Actions tab. There's nothing else to configure — no registry, no secrets, no tokens. The health job pushes to
`main` with the workflow's own token, so if you protect that branch, allow GitHub Actions to push.
Delete `data/` and `HEALTH.md` in your fork to start your own history.
Update the URL in `index.html` to match your fork.

## Credits

The data is public output from [GraphAggregator](https://github.com/HarutoHiroki/GraphAggregator)
(Haruto Hiroki) and squig.link. GAA only merges and slims it; all the actual crawling, verification
and federation happens upstream.

Licensed under MPL-2.0, matching GraphAggregator.
