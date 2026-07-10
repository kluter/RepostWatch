#!/usr/bin/env python3
"""Poll public ATS job feeds, diff against the previous snapshot, append structural events.

Tracks job-posting metadata only (no content scraping): when roles open, close,
and get republished with a fresh timestamp or a new job id.

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

    prev_jobs = None
    if state_path.exists():
        prev_jobs = json.loads(state_path.read_text(encoding="utf-8"))["jobs"]
        if not cur_jobs and prev_jobs:
            # An empty feed is far more likely an outage than every role closing at
            # once; emitting a wave of closes here would poison the event log.
            print(f"  {slug}: feed returned 0 listed jobs while {len(prev_jobs)} were known; "
                  f"skipping diff, keeping previous state", file=sys.stderr)
            return {"slug": slug, "skipped": True, "locations": [j["location"] for j in prev_jobs]}
        recent_closes = load_recent_closes(events_path)
        events = diff_events(slug, ats, prev_jobs, cur_jobs, recent_closes, now)
    else:
        # First run: seed the log. These roles were not observed opening today,
        # so they get their own type; date is observation time, published_at
        # carries the real feed timestamp.
        events = [make_event("initialized", slug, ats, job, now_iso) for job in cur_jobs]

    events.sort(key=lambda e: (e["type"] != "closed", e["published_at"], e["title"]))

    # Only rewrite the snapshot when the jobs actually changed. Otherwise a no-op poll
    # would still bump fetched_at and produce a daily commit with no real data in it.
    if prev_jobs is None or cur_jobs != prev_jobs:
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
    print(f"  {slug}: {len(cur_jobs)} listed jobs; events: {counts or 'none'}")
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

    # macro-regions / non-places Nominatim would mis-resolve to a random point
    NON_PLACES = {"emea", "apac", "amer", "amers", "namer", "na", "latam", "europe",
                  "global", "worldwide", "anywhere", "remote", "international"}

    def anchor(raw: str) -> str:
        # Drop "(Remote)"-style modes, then strip 'remote' and macro-region tokens,
        # leaving the geographic part to geocode: "Canada, Remote" -> "Canada".
        s = re.sub(r"\s*\([^)]*\)\s*", " ", raw)
        parts = [p.strip() for p in re.split(r"[,/]", s) if p.strip()]
        return ", ".join(p for p in parts if p.lower() not in NON_PLACES)

    changed = False
    for loc in sorted({(l or "").strip() for l in locations}):
        key = loc.lower()
        if not key or key in locs:
            continue
        is_remote = re.search(r"\bremote\b", key) is not None
        geo = anchor(loc)
        if not geo:                         # bare/macro remote ("APAC, Remote") -> no map point
            locs[key] = None
            changed = True
            print(f"  geocoded {loc!r} -> None (remote, no fixed place)")
            continue
        try:
            url = "https://nominatim.openstreetmap.org/search?" + urlencode(
                {"q": geo, "format": "json", "limit": 1})
            data = http_get_json(url)
            if data:
                entry = {"lat": float(data[0]["lat"]), "lon": float(data[0]["lon"]),
                         # remote roles anchor to a region — keep that region as the label
                         "label": geo if is_remote else data[0].get("display_name", loc).split(",")[0]}
                if is_remote:
                    entry["remote"] = True
                locs[key] = entry
            else:
                locs[key] = None            # cache the miss so we don't re-query forever
            changed = True
            print(f"  geocoded {loc!r} -> {locs[key]}")
            time.sleep(1.1)                 # Nominatim asks for <= 1 req/sec
        except Exception as exc:            # network hiccup: leave uncached, retry next run
            print(f"  geocode failed for {loc!r}: {exc}", file=sys.stderr)

    if changed:
        GEOCACHE_PATH.write_text(json.dumps(cache, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def write_company_index(companies: list[dict]) -> None:
    # Company entries pass through as-is so the dashboard sees name/website/facts.
    # No generated_at timestamp: it would change every run and force an empty commit.
    # Only (re)write when the config actually differs from what's on disk.
    DATA_DIR.mkdir(exist_ok=True)
    path = DATA_DIR / "index.json"
    new = json.dumps({"companies": companies}, indent=1, ensure_ascii=False) + "\n"
    if not path.exists() or path.read_text(encoding="utf-8") != new:
        path.write_text(new, encoding="utf-8")


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
    write_company_index(companies)

    if failures:
        print(f"{len(failures)} company poll(s) failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
