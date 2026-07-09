#!/usr/bin/env python3
"""Poll public ATS job feeds, diff against the previous snapshot, append structural events.

Tracks job-posting metadata only (no content scraping): when roles open, close,
get republished with a fresh timestamp or a new job id, and when several
near-identical roles are published together as a batch.

Data layout, per company:
    data/{slug}/current_state.json  -- overwritten every run; normalized snapshot of listed jobs
    data/{slug}/events.jsonl        -- append-only event log, one JSON object per line
    data/index.json                 -- list of tracked companies, for the dashboard
"""

import email.utils
import hashlib
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
GEOCACHE_PATH = DATA_DIR / "geocache.json"

# A close followed by a matching reappearance within this window counts as a republish.
REPUBLISH_WINDOW_DAYS = 60
# Minimum number of near-identical postings published in one burst to tag as a batch.
BATCH_MIN_SIZE = 3
# Max gap between consecutive publish timestamps inside one batch. Gap-based rather
# than calendar-hour so a burst straddling an hour boundary stays one batch.
BATCH_MAX_GAP = timedelta(hours=1)

USER_AGENT = "RepostWatch (public ATS metadata poller; github.com/kluter/RepostWatch)"


# --------------------------------------------------------------------------- helpers

def norm(s: str) -> str:
    """Lowercase ascii slug: 'Forward Deployed  Engineer, Berlin' -> 'forward-deployed-engineer-berlin'."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def parse_ts(s: str):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def lineage_key(job: dict) -> str:
    """Stable identity for a role across republishes (job ids regenerate every time)."""
    return f"{norm(job['title'])}@{norm(job['location'])}"


def title_template(title: str, location: str) -> str:
    """Title with location cues removed, for grouping near-identical batch postings.

    'Forward Deployed Geospatial Engineer - SAR Intelligence, Berlin' and the
    Espoo/Athens/... variants must all map to the same template. The trailing
    comma segment is stripped only when short, and tokens from the location
    field are dropped (the two don't always agree in real feeds).
    """
    t = (title or "").strip()
    if "," in t:
        head, tail = t.rsplit(",", 1)
        if len(tail.split()) <= 3:
            t = head
    loc_tokens = set(norm(location).split("-"))
    kept = [tok for tok in norm(t).split("-") if tok and tok not in loc_tokens]
    return "-".join(kept) or norm(title)


def http_get_json(url: str) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=60) as resp:
        return json.load(resp)


def http_get_bytes(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=60) as resp:
        return resp.read()


# multi-location separators: a semicolon, or a space-flanked dash/slash/pipe
# (hyphen, en dash, em dash). Space-flanked so hyphenated names like Baden-Baden survive.
_LOC_SPLIT = re.compile(r"\s*;\s*|\s+[-–—/|]\s+")


def primary_location(loc: str) -> str:
    """First city of a multi-location string: 'Munich – Berlin – London' -> 'Munich',
    'Barcelona; Berlin; Paris' -> 'Barcelona'. Single 'City, Country' is left intact so it
    still geocodes precisely."""
    if not loc:
        return ""
    return _LOC_SPLIT.split(loc)[0].strip()


_CORP = re.compile(r"\b(GmbH|mbH|AG|Inc\.?|Ltd\.?|LLC|Co\.?|Office|HQ)\b", re.I)


def _common_leading_words(strings: list[str]) -> int:
    """How many leading whitespace-split words all strings share (e.g. a company prefix)."""
    splits = [s.split() for s in strings if s.split()]
    if len(splits) < 2:
        return 0
    n = 0
    for i in range(min(len(s) for s in splits) - 1):   # never strip the whole string
        if all(s[i] == splits[0][i] for s in splits):
            n += 1
        else:
            break
    return n


def _clean_office(office: str, prefix_n: int) -> str:
    """Turn a Personio office label into a geocodable place:
    'LiveEO GmbH Berlin (Onsite)' -> 'Berlin', 'LiveEO United Kingdom (Remote)' -> 'United Kingdom'."""
    words = office.split()[prefix_n:]
    s = re.sub(r"\s*\([^)]*\)\s*", " ", " ".join(words))   # drop the (Onsite)/(Remote) mode
    s = _CORP.sub("", s)                                    # drop corporate tokens
    return re.sub(r"\s{2,}", " ", s).strip(" ,.-")         # trim stray spaces/punctuation


def normalize_job(job_id, title, location, published_at, url,
                  department="", team="", is_remote=False, desc="") -> dict:
    """Common normalized shape every adapter emits (metadata only)."""
    title = (title or "").strip()
    location = (location or "").strip()
    return {
        "job_id": str(job_id or ""),
        "lineage_key": f"{norm(title)}@{norm(location)}",
        "title": title,
        "department": (department or "").strip(),
        "team": (team or "").strip(),
        "location": location,
        "secondary_locations": [],
        "employment_type": "",
        "workplace_type": "",
        "is_remote": bool(is_remote),
        "published_at": published_at or "",
        "url": url or "",
        "description_sha256": hashlib.sha256((desc or "").encode("utf-8")).hexdigest(),
    }


# --------------------------------------------------------------------------- ATS adapters
# Each adapter fetches one board and returns a list of normalized job dicts
# (metadata only; descriptions are reduced to a hash for future fuzzy matching).

def fetch_ashby(board: str) -> list[dict]:
    raw = http_get_json(f"https://api.ashbyhq.com/posting-api/job-board/{board}")
    jobs = []
    for j in raw.get("jobs", []):
        if not j.get("isListed", True):
            continue
        desc = j.get("descriptionPlain") or ""
        title, location = (j.get("title") or "").strip(), j.get("location") or ""
        jobs.append({
            "job_id": j.get("id") or "",
            "lineage_key": f"{norm(title)}@{norm(location)}",
            "title": title,
            "department": j.get("department") or "",
            "team": j.get("team") or "",
            "location": location,
            "secondary_locations": [s.get("location", "") for s in j.get("secondaryLocations") or []],
            "employment_type": j.get("employmentType") or "",
            "workplace_type": j.get("workplaceType") or "",
            "is_remote": bool(j.get("isRemote")),
            "published_at": j.get("publishedAt") or "",
            "url": j.get("jobUrl") or "",
            "description_sha256": hashlib.sha256(desc.encode("utf-8")).hexdigest(),
        })
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


def fetch_greenhouse(board: str) -> list[dict]:
    base = f"https://boards-api.greenhouse.io/v1/boards/{board}"
    data = http_get_json(f"{base}/jobs")
    dept_of = {}                       # the /jobs list omits departments; enrich from /departments
    try:
        for d in http_get_json(f"{base}/departments").get("departments", []):
            for j in d.get("jobs", []):
                dept_of[str(j.get("id"))] = d.get("name", "")
    except Exception:
        pass
    jobs = []
    for j in data.get("jobs", []):
        jid = str(j.get("id"))
        loc = primary_location((j.get("location") or {}).get("name", ""))
        jobs.append(normalize_job(
            jid, j.get("title"), loc,
            j.get("first_published") or j.get("updated_at") or "",
            j.get("absolute_url"),
            department=dept_of.get(jid, ""), is_remote="remote" in (loc or "").lower()))
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


def fetch_recruitee(board: str) -> list[dict]:
    raw = http_get_json(f"https://{board}.recruitee.com/api/offers/")
    jobs = []
    for o in raw.get("offers", []):
        if o.get("status") != "published":
            continue
        city, country = (o.get("city") or "").strip(), (o.get("country") or "").strip()
        loc = ", ".join(x for x in (city, country) if x)
        pub = o.get("published_at") or o.get("created_at") or ""
        if pub.endswith(" UTC"):        # "2026-07-02 13:00:52 UTC" -> ISO
            pub = pub[:-4].strip().replace(" ", "T") + "+00:00"
        jobs.append(normalize_job(
            o.get("id"), o.get("title"), loc, pub, o.get("careers_url"),
            department=o.get("department"), is_remote=bool(o.get("remote")),
            desc=o.get("description")))
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


def fetch_personio(board: str) -> list[dict]:
    root = ET.fromstring(http_get_bytes(f"https://{board}.jobs.personio.de/xml"))
    positions = root.findall(".//position")

    def gp(p, tag):
        el = p.find(tag)
        return (el.text or "").strip() if el is not None and el.text else ""

    # offices are labels like "LiveEO GmbH Berlin (Onsite)"; strip the shared company
    # prefix + corporate tokens + mode so the location is a geocodable place.
    prefix_n = _common_leading_words([re.sub(r"\s*\([^)]*\)\s*$", "", gp(p, "office")) for p in positions])
    jobs = []
    for p in positions:
        jid, office = gp(p, "id"), gp(p, "office")
        url = f"https://{board}.jobs.personio.de/job/{jid}" if jid else ""
        jobs.append(normalize_job(
            jid, gp(p, "name"), _clean_office(office, prefix_n), gp(p, "createdAt"), url,
            department=gp(p, "department"), is_remote="remote" in office.lower(),
            desc=gp(p, "jobDescriptions")))
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


def fetch_teamtailor(board: str) -> list[dict]:
    # board is the careers host, e.g. "careers.open-cosmos.com"
    TT = "{https://teamtailor.com/locations}"
    root = ET.fromstring(http_get_bytes(f"https://{board}/jobs.rss"))
    jobs = []
    for it in root.findall(".//item"):
        def g(tag):
            el = it.find(tag)
            return (el.text or "").strip() if el is not None and el.text else ""
        pub = g("pubDate")
        if pub:
            try:
                pub = email.utils.parsedate_to_datetime(pub).isoformat()
            except (TypeError, ValueError):
                pass
        # <tt:locations> holds one or more <tt:location> children; take the first's name
        loc = ""
        locs_el = it.find(TT + "locations")
        if locs_el is not None:
            first = locs_el.find(TT + "location")
            if first is not None:
                loc = (first.findtext(TT + "name") or "").strip()
                if not loc:
                    city = (first.findtext(TT + "city") or "").strip()
                    country = (first.findtext(TT + "country") or "").strip()
                    loc = ", ".join(x for x in (city, country) if x)
        remote = g("remoteStatus")
        jobs.append(normalize_job(
            g("guid"), g("title"), primary_location(loc), pub, g("link"),
            department=g(TT + "department"), is_remote=remote not in ("", "none"),
            desc=g("description")))
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


ADAPTERS = {
    "ashby": fetch_ashby,
    "greenhouse": fetch_greenhouse,
    "recruitee": fetch_recruitee,
    "personio": fetch_personio,
    "teamtailor": fetch_teamtailor,
}


# --------------------------------------------------------------------------- events

def make_event(etype: str, company: str, source: str, job: dict, date_iso: str, **extra) -> dict:
    ev = {
        "date": date_iso,
        "type": etype,
        "company": company,
        "source": source,
        "job_id": job["job_id"],
        "title": job["title"],
        "location": job["location"],
        "department": job["department"],
        "published_at": job["published_at"],
        "lineage_key": lineage_key(job),
        "url": job.get("url", ""),
    }
    ev.update(extra)
    return ev


def load_recent_closes(events_path: Path) -> dict:
    """lineage_key -> datetime of most recent 'closed' event."""
    closes = {}
    if not events_path.exists():
        return closes
    for line in events_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        if ev.get("type") != "closed":
            continue
        lk = ev.get("lineage_key")
        ts = parse_ts(ev.get("date", ""))
        if lk and ts and (lk not in closes or ts > closes[lk]):
            closes[lk] = ts
    return closes


def diff_events(company, source, prev_jobs, cur_jobs, recent_closes, now) -> list[dict]:
    prev_by_id = {j["job_id"]: j for j in prev_jobs}
    cur_by_id = {j["job_id"]: j for j in cur_jobs}
    now_iso = now.isoformat(timespec="seconds")
    events = []

    # Disappearances first, so an id rotation within a single poll
    # (old id gone, new id present, same role) resolves to closed + republished.
    for jid, job in prev_by_id.items():
        if jid not in cur_by_id:
            events.append(make_event("closed", company, source, job, now_iso))
            lk = lineage_key(job)
            if lk not in recent_closes or now > recent_closes[lk]:
                recent_closes[lk] = now

    for jid, job in cur_by_id.items():
        if jid not in prev_by_id:
            closed_at = recent_closes.get(lineage_key(job))
            if closed_at is not None and now - closed_at <= timedelta(days=REPUBLISH_WINDOW_DAYS):
                events.append(make_event("republished", company, source, job, now_iso,
                                         mechanism="new_job_id"))
            else:
                events.append(make_event("opened", company, source, job, now_iso))
        else:
            prev_pub = prev_by_id[jid]["published_at"]
            if prev_pub and job["published_at"] != prev_pub:
                # The observed ICEYE mechanism: the job never leaves the feed,
                # it just gets a fresh publishedAt.
                events.append(make_event("republished", company, source, job, now_iso,
                                         mechanism="published_at_changed",
                                         previous_published_at=prev_pub))

    return events


def tag_batches(events: list[dict]) -> None:
    """Tag bursts of >= BATCH_MIN_SIZE near-identical postings with a shared batch_id.

    Every event still gets its own full row; the batch is only visible through
    the shared batch_id, never as a rollup.
    """
    def flush(cluster, template):
        if len(cluster) < BATCH_MIN_SIZE:
            return
        first = parse_ts(cluster[0]["published_at"])
        short = "-".join(template.split("-")[:4])
        batch_id = f"{first.date().isoformat()}-{short}"
        for ev in cluster:
            ev["batch_id"] = batch_id

    by_template = {}
    for ev in events:
        if ev["type"] in ("opened", "republished", "initialized") and parse_ts(ev["published_at"]):
            key = title_template(ev["title"], ev["location"])
            by_template.setdefault(key, []).append(ev)

    for template, evs in by_template.items():
        evs.sort(key=lambda e: parse_ts(e["published_at"]))
        cluster = [evs[0]]
        for ev in evs[1:]:
            if parse_ts(ev["published_at"]) - parse_ts(cluster[-1]["published_at"]) <= BATCH_MAX_GAP:
                cluster.append(ev)
            else:
                flush(cluster, template)
                cluster = [ev]
        flush(cluster, template)


# --------------------------------------------------------------------------- per-company run

def run_company(cfg: dict, now: datetime) -> dict:
    slug, ats, board = cfg["slug"], cfg["ats"], cfg["board"]
    fetch = ADAPTERS.get(ats)
    if fetch is None:
        raise RuntimeError(f"no adapter for ats type {ats!r}")

    cur_jobs = fetch(board)

    company_dir = DATA_DIR / slug
    company_dir.mkdir(parents=True, exist_ok=True)
    state_path = company_dir / "current_state.json"
    events_path = company_dir / "events.jsonl"
    now_iso = now.isoformat(timespec="seconds")

    if state_path.exists():
        prev_jobs = json.loads(state_path.read_text(encoding="utf-8"))["jobs"]
        if not cur_jobs and prev_jobs:
            # An empty feed is far more likely an outage than every role closing at
            # once; emitting a wave of closes here would poison the event log.
            print(f"  {slug}: feed returned 0 listed jobs while {len(prev_jobs)} were known; "
                  f"skipping diff, keeping previous state", file=sys.stderr)
            return {"slug": slug, "skipped": True}
        recent_closes = load_recent_closes(events_path)
        events = diff_events(slug, ats, prev_jobs, cur_jobs, recent_closes, now)
    else:
        # First run: seed the log. These roles were not observed opening today,
        # so they get their own type; date is observation time, published_at
        # carries the real feed timestamp.
        events = [make_event("initialized", slug, ats, job, now_iso) for job in cur_jobs]

    tag_batches(events)
    events.sort(key=lambda e: (e["type"] != "closed", e["published_at"], e["title"]))

    state = {
        "company": slug,
        "source": ats,
        "board": board,
        "fetched_at": now_iso,
        "job_count": len(cur_jobs),
        "jobs": cur_jobs,
    }
    state_path.write_text(json.dumps(state, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")

    if events:
        with events_path.open("a", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")

    counts = {}
    for ev in events:
        counts[ev["type"]] = counts.get(ev["type"], 0) + 1
    batches = sorted({ev["batch_id"] for ev in events if "batch_id" in ev})
    print(f"  {slug}: {len(cur_jobs)} listed jobs; events: {counts or 'none'}"
          + (f"; batches: {', '.join(batches)}" if batches else ""))
    return {"slug": slug, "job_count": len(cur_jobs), "events": counts,
            "locations": [j["location"] for j in cur_jobs]}


def geocode_new_locations(locations) -> None:
    """Resolve any not-yet-cached location to lat/lon via Nominatim, once, and commit it.

    The dashboard reads only this committed cache and never geocodes client-side.
    Usually a no-op: real requests happen only when a genuinely new location appears.
    """
    import time
    cache = {"locations": {}}
    if GEOCACHE_PATH.exists():
        cache = json.loads(GEOCACHE_PATH.read_text(encoding="utf-8"))
    locs = cache.setdefault("locations", {})

    # regions / non-places that Nominatim would mis-resolve to a random point
    NON_PLACES = {"emea", "apac", "amer", "amers", "global", "worldwide", "anywhere", "remote", "international"}

    changed = False
    for loc in sorted({(l or "").strip() for l in locations}):
        key = loc.lower()
        if not key or key in locs:
            continue
        if key in NON_PLACES:
            locs[key] = None
            changed = True
            continue
        try:
            url = "https://nominatim.openstreetmap.org/search?" + urlencode(
                {"q": loc, "format": "json", "limit": 1})
            data = http_get_json(url)
            if data:
                locs[key] = {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"]),
                             "label": data[0].get("display_name", loc).split(",")[0]}
            else:
                locs[key] = None            # cache the miss so we don't re-query forever
            changed = True
            print(f"  geocoded {loc!r} -> {locs[key]}")
            time.sleep(1.1)                 # Nominatim asks for <= 1 req/sec
        except Exception as exc:            # network hiccup: leave uncached, retry next run
            print(f"  geocode failed for {loc!r}: {exc}", file=sys.stderr)

    if changed:
        GEOCACHE_PATH.write_text(json.dumps(cache, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def write_company_index(companies: list[dict], now: datetime) -> None:
    # Pass company entries through as-is so the dashboard sees name/website/facts.
    index = {
        "generated_at": now.isoformat(timespec="seconds"),
        "companies": companies,
    }
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "index.json").write_text(
        json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    import yaml   # deferred so helper scripts can import this module without PyYAML
    now = datetime.now(timezone.utc)
    companies = yaml.safe_load((ROOT / "companies.yaml").read_text(encoding="utf-8")) or []
    print(f"RepostWatch poll @ {now.isoformat(timespec='seconds')} — {len(companies)} company(ies)")

    failures = []
    all_locations = []
    for cfg in companies:
        try:
            result = run_company(cfg, now)
            all_locations.extend(result.get("locations", []))
        except Exception as exc:  # keep polling remaining companies; fail the run at the end
            failures.append(f"{cfg.get('slug', '?')}: {exc}")
            print(f"  {cfg.get('slug', '?')}: FAILED — {exc}", file=sys.stderr)

    geocode_new_locations(all_locations)   # one pass over the shared cache for the whole poll
    write_company_index(companies, now)

    if failures:
        print(f"{len(failures)} company poll(s) failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
