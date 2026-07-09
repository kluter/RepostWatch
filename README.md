# RepostWatch

Tracks job-posting **metadata** over time: when roles open, close, get republished, and when
several near-identical roles are published together ("batch publishes"). Data comes exclusively
from each company's own public, no-auth ATS feed (Ashby, etc.) — structural metadata only.

**Non-goals, by design:** no LinkedIn scraping or automation of any kind, no content-level
scraping (descriptions are reduced to a hash), no tracking of individuals. Headcount figures are
never automated — they are entered by hand from public annual sources.

## How it works

A GitHub Actions cron job runs [poll.py](poll.py) daily, diffs each company's feed against the
previous snapshot, and commits the results back to the repo. GitHub Pages serves a static
dashboard that reads the committed data client-side. No server, no database, no build step.

```
data/{company}/current_state.json   overwritten each run — normalized snapshot of listed jobs
data/{company}/events.jsonl         append-only event log, one JSON object per line
data/index.json                     list of tracked companies, for the dashboard

index.html                          dashboard page structure
css/style.css                       styling (dark theme, TracePoint family design)
js/app.js                           data loading, company routing (#slug), rendering
js/charts.js                        hand-rolled SVG chart components, no dependencies
```

## Event model

Each line in `events.jsonl` is one fully granular event — batches are never rolled up, they are
visible through a shared `batch_id` on individual rows.

| type | meaning |
|---|---|
| `initialized` | job was already listed when tracking began (first-run import; not an observed opening) |
| `opened` | job id appeared in the feed |
| `closed` | job id disappeared from the feed |
| `republished` | same role published again — either `mechanism: published_at_changed` (job stayed listed, got a fresh `publishedAt`; the mechanism observed at ICEYE) or `mechanism: new_job_id` (role reappeared under a new id within 60 days of closing) |
| `headcount_manual` | hand-entered headcount observation (`value`, `source`) |

Because ATS job ids regenerate on every republish, each event also carries a `lineage_key`
(normalized title + location) that stays stable across republishes, so the dashboard can say
"this role has been published N times" without collapsing the underlying events.

Batch detection: ≥3 postings with a near-identical title template (location cues stripped)
whose `publishedAt` timestamps form a burst (≤1h gap between consecutive postings) share a
`batch_id` like `2026-07-01-forward-deployed-geospatial-engineer`.

Safety guard: if a feed suddenly returns zero jobs while jobs were previously known, the diff is
skipped for that run (an outage would otherwise log a wave of fake closes).

## Adding a company

Add an entry to [companies.yaml](companies.yaml):

```yaml
- slug: acme
  ats: ashby        # adapter; currently implemented: ashby
  board: acme       # board id in the ATS feed URL
```

If the company uses a different ATS (Greenhouse, Lever, Workable, Personio — all have public
feeds), add a `fetch_*` adapter in `poll.py` that returns the same normalized job dicts and
register it in `ADAPTERS`. Everything downstream is ATS-agnostic.

## Manual headcount entries

```
python add_headcount.py iceye 720 --source revelio
python add_headcount.py iceye 750 --source linkedin_estimate --date 2026-07-01
```

## Running locally

```
pip install -r requirements.txt
python poll.py
```

or without a local Python, via Docker:

```
docker run --rm -v "$PWD:/work" -w /work python:3.12-slim \
  sh -c "pip install -q -r requirements.txt && python poll.py"
```

To view the dashboard locally, serve the repo root (`python -m http.server`) — `index.html`
fetches `data/` relative to itself. On GitHub, enable Pages: Settings → Pages → Deploy from a
branch → `main` / `/ (root)`.
