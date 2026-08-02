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


def fetch_workable(board: str) -> list[dict]:
    # board is the Workable account slug; the public widget feed needs no auth.
    data = http_get_json(f"https://apply.workable.com/api/v1/widget/accounts/{board}?details=true")
    # Workable lists a multi-city role once per city, all sharing one shortcode. Collapse them
    # into a single posting per shortcode so one role isn't counted several times (and its id
    # can't collide in the diff). Cities are merged; the alphabetically-first is the primary
    # location (stable regardless of feed order), the rest become secondary.
    grouped, order = {}, []
    for j in data.get("jobs", []):
        code = j.get("shortcode") or ""
        if code not in grouped:
            grouped[code] = []
            order.append(code)
        grouped[code].append(j)
    jobs = []
    for code in order:
        variants = grouped[code]
        j = variants[0]
        remote = bool(j.get("telecommuting"))
        cities = []
        for v in variants:
            loc0 = (v.get("locations") or [{}])[0]
            city = (loc0.get("city") or v.get("city") or "").strip()
            country = (loc0.get("country") or v.get("country") or "").strip()
            place = ", ".join(x for x in (city, country) if x)
            if place and place not in cities:
                cities.append(place)
        cities.sort()
        location = cities[0] if cities else ("Remote" if remote else "")
        pub = j.get("published_on") or j.get("created_at") or ""
        if pub and "T" not in pub:                     # "2026-07-07" -> full ISO
            pub = pub + "T00:00:00+00:00"
        job = normalize_job(
            code, j.get("title"), location, pub,
            j.get("url") or j.get("shortlink") or f"https://apply.workable.com/j/{code}",
            department=j.get("department") or "", is_remote=remote,
            desc=j.get("description") or "")
        job["secondary_locations"] = cities[1:]
        jobs.append(job)
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


def _wd_facet_values(facets, param):
    """Find a facet's value list anywhere in Workday's (sometimes nested) facet tree."""
    for f in facets or []:
        if f.get("facetParameter") == param:
            return f.get("values", [])
        found = _wd_facet_values(f.get("values"), param)
        if found:
            return found
    return []


def fetch_workday(cfg) -> list[dict]:
    """Workday CXS public API. cfg['board'] is 'host/tenant/site'
    (e.g. 'ag.wd3.myworkdayjobs.com/ag/Airbus'); optional cfg['company'] and cfg['locations']
    filter by hiring entity and site (matched by name, so new sites include themselves). The
    list only carries a relative 'Posted N days ago', so the true date comes from each job's
    detail (startDate) — fetched once and then reused from the previous snapshot to stay cheap."""
    import time
    host, tenant, site = cfg["board"].split("/")
    base = f"https://{host}/wday/cxs/{tenant}/{site}"
    company, want_locs = cfg.get("company", ""), set(cfg.get("locations") or [])

    def post_jobs(applied, offset):
        time.sleep(1.2)                       # space out /jobs POSTs — Workday throttles rapid ones
        body = json.dumps({"appliedFacets": applied, "limit": 20, "offset": offset,
                           "searchText": ""}).encode("utf-8")
        req = Request(f"{base}/jobs", data=body, headers={
            "User-Agent": USER_AGENT, "Accept": "application/json", "Content-Type": "application/json"})
        with urlopen(req, timeout=60) as resp:
            return json.load(resp)

    def resolve(applied, param):              # facet lookup, retried since a throttled POST drops it
        for _ in range(3):
            vals = _wd_facet_values(post_jobs(applied, 0).get("facets", []), param)
            if vals:
                return vals
        return []

    applied = {}
    if company:
        # Workday prefixes the name with an internal code ("922E Airbus Defence and Space GmbH"),
        # so match by substring rather than requiring the exact descriptor.
        cid = next((v["id"] for v in resolve({}, "hiringCompany")
                    if company in (v.get("descriptor") or "")), None)
        if cid is None:
            raise RuntimeError(f"workday: hiring company {company!r} not found on {tenant}/{site}")
        applied["hiringCompany"] = [cid]
    if want_locs:
        loc_ids = [v["id"] for v in resolve(dict(applied), "locations")
                   if v.get("descriptor") in want_locs]
        if not loc_ids:                       # throttled or misconfigured: never fall back to "all"
            raise RuntimeError(f"workday: no configured location resolved on {tenant}/{site}")
        applied["locations"] = loc_ids

    # reuse date + resolved location from the previous snapshot; only new ids need a detail hit
    prev = {}
    state_path = DATA_DIR / cfg["slug"] / "current_state.json"
    if state_path.exists():
        for j in json.loads(state_path.read_text(encoding="utf-8")).get("jobs", []):
            if j.get("published_at"):
                prev[j["job_id"]] = (j["published_at"], j.get("location", ""), j.get("secondary_locations", []))

    def detail(external_path, req_id):
        # (published_at, primary location, [additional locations]). The list only carries a relative
        # date and a collapsed "N Locations", so the detail (startDate, location) is the real source.
        cached = prev.get(req_id)
        if cached and cached[0] and "Locations" not in cached[1]:   # reuse unless the location was collapsed
            return cached
        time.sleep(0.3)
        try:
            info = http_get_json(base + external_path).get("jobPostingInfo", {})
            sd = info.get("startDate") or ""
            return (sd + "T00:00:00+00:00" if sd else "",
                    (info.get("location") or "").strip(),
                    [a for a in (info.get("additionalLocations") or []) if a])
        except Exception:
            return ("", "", [])

    # Workday reports the real count only on the first page and then wraps instead of returning
    # an empty page, so bound pagination by that total (and de-dupe by req id as a backstop).
    first = post_jobs(applied, 0)
    total = first.get("total") or 0
    postings, offset = list(first.get("jobPostings", [])), 20
    while offset < total:
        page = post_jobs(applied, offset).get("jobPostings", [])
        if not page:
            break
        postings += page
        offset += 20

    jobs, seen = [], set()
    for j in postings:
        ep = j.get("externalPath") or ""
        req_id = (j.get("bulletFields") or [""])[0] or ep.rsplit("_", 1)[-1]
        if not req_id or req_id in seen:
            continue
        seen.add(req_id)
        pub, loc, extra = detail(ep, req_id)
        loc = loc or (j.get("locationsText") or "").strip()   # fall back to the list if the detail lacks it
        job = normalize_job(
            req_id, j.get("title"), loc, pub,
            f"https://{host}/{site}{ep}" if ep else "",
            is_remote="remote" in loc.lower())
        job["secondary_locations"] = extra
        jobs.append(job)
    jobs.sort(key=lambda j: j["job_id"])
    return jobs


ADAPTERS = {
    "ashby": fetch_ashby,
    "greenhouse": fetch_greenhouse,
    "recruitee": fetch_recruitee,
    "personio": fetch_personio,
    "teamtailor": fetch_teamtailor,
    "workable": fetch_workable,
    "workday": fetch_workday,
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


def load_history(events_path: Path):
    """One pass over the event log, returning three things:
      closes_by_lineage -- lineage_key -> datetime of its most recent 'closed'
      closes_by_id      -- job_id -> datetime of its most recent 'closed'
      seed              -- datetime of our first poll (the earliest event we recorded)
    A job that reappears after we saw its lineage OR its exact id close is an observed
    republish (the id survives a rename, which the lineage key does not). A job posted before
    the seed was already up when we started watching -- a straggler, part of the baseline."""
    closes_by_lineage, closes_by_id, seed = {}, {}, None
    if not events_path.exists():
        return closes_by_lineage, closes_by_id, seed
    for line in events_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        ev = json.loads(line)
        if ev.get("type") == "headcount_manual":
            continue
        ts = parse_ts(ev.get("date", ""))
        if ts is None:
            continue
        if seed is None or ts < seed:
            seed = ts
        if ev.get("type") == "closed":
            lk = ev.get("lineage_key")
            if lk and (lk not in closes_by_lineage or ts > closes_by_lineage[lk]):
                closes_by_lineage[lk] = ts
            jid = ev.get("job_id")
            if jid and (jid not in closes_by_id or ts > closes_by_id[jid]):
                closes_by_id[jid] = ts
    return closes_by_lineage, closes_by_id, seed


def diff_events(company, source, prev_jobs, cur_jobs, closes_by_lineage, closes_by_id, seed, now) -> list[dict]:
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
            if lk not in closes_by_lineage or now > closes_by_lineage[lk]:
                closes_by_lineage[lk] = now
            if jid not in closes_by_id or now > closes_by_id[jid]:
                closes_by_id[jid] = now

    for jid, job in cur_by_id.items():
        if jid not in prev_by_id:
            pub = parse_ts(job.get("published_at"))
            # observed close of this role, by its lineage or by its exact id (survives a rename)
            prior = [c for c in (closes_by_lineage.get(lineage_key(job)), closes_by_id.get(jid)) if c is not None]
            closed_at = max(prior) if prior else None
            if closed_at is not None and now - closed_at <= timedelta(days=REPUBLISH_WINDOW_DAYS):
                # only an observed repost: we watched this exact role leave the feed and
                # reappear. we never guess a repost from an old posting date.
                events.append(make_event("republished", company, source, job, now_iso,
                                         mechanism="new_job_id"))
            elif seed is not None and pub is not None and pub.date() < seed.date():
                # posted before we started watching this company: a straggler our first poll
                # missed, so it's part of the baseline, not a role we watched open.
                events.append(make_event("initialized", company, source, job, now_iso))
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

def record_feed_outage(slug, source, board, state_path, exc, now_iso) -> dict:
    """A feed was unreachable. Keep the last-known snapshot but stamp it with the error, so the
    dashboard can show 'feed unavailable' (with the status received) instead of silently going
    stale. A reachable feed clears this again on the next successful poll."""
    code = getattr(exc, "code", None)                      # HTTPError carries .code (404, 500, …)
    if code:
        message = f"HTTP {code}"
    elif isinstance(exc, (json.JSONDecodeError, ET.ParseError)):
        message = "invalid response"
    elif isinstance(exc, TimeoutError):
        message = "timed out"
    else:
        reason = getattr(exc, "reason", None)
        message = f"unreachable ({reason})" if reason else "unreachable"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    else:
        state = {"company": slug, "source": source, "board": board,
                 "fetched_at": None, "job_count": 0, "jobs": []}
    state["feed_error"] = {"code": code, "message": message, "checked_at": now_iso}
    state_path.write_text(json.dumps(state, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"  {slug}: feed unavailable ({message}); kept last-known data, flagged on dashboard",
          file=sys.stderr)
    return {"slug": slug, "feed_error": message,
            "locations": [j.get("location", "") for j in state.get("jobs", [])]}


def run_company(cfg: dict, now: datetime) -> dict:
    slug, ats, board = cfg["slug"], cfg["ats"], cfg["board"]
    fetch = ADAPTERS.get(ats)
    if fetch is None:
        raise RuntimeError(f"no adapter for ats type {ats!r}")

    company_dir = DATA_DIR / slug
    company_dir.mkdir(parents=True, exist_ok=True)
    state_path = company_dir / "current_state.json"
    events_path = company_dir / "events.jsonl"
    now_iso = now.isoformat(timespec="seconds")

    try:
        # workday needs the whole config (company/location filter, slug for its date cache);
        # every other adapter takes just the board string.
        cur_jobs = fetch(cfg) if ats == "workday" else fetch(board)
    except (OSError, json.JSONDecodeError, ET.ParseError) as exc:
        # any feed problem — unreachable, HTTP error (capella hit 404), timeout, or a garbage
        # response — is an external outage, not our bug: record it for the dashboard and keep
        # polling the rest. OSError covers HTTPError / URLError / timeouts / connection resets;
        # the two parse errors cover a 200 that returns unusable JSON or XML.
        return record_feed_outage(slug, ats, board, state_path, exc, now_iso)

    prev_jobs = None
    had_error = False                       # a prior outage we're now recovering from
    if state_path.exists():
        prev_state = json.loads(state_path.read_text(encoding="utf-8"))
        prev_jobs = prev_state["jobs"]
        had_error = "feed_error" in prev_state
        if not cur_jobs and prev_jobs:
            # An empty feed is far more likely an outage than every role closing at
            # once; emitting a wave of closes here would poison the event log.
            print(f"  {slug}: feed returned 0 listed jobs while {len(prev_jobs)} were known; "
                  f"skipping diff, keeping previous state", file=sys.stderr)
            return {"slug": slug, "skipped": True, "locations": [j["location"] for j in prev_jobs]}
        closes_by_lineage, closes_by_id, seed = load_history(events_path)
        events = diff_events(slug, ats, prev_jobs, cur_jobs, closes_by_lineage, closes_by_id, seed, now)
    else:
        # First run: seed the log. These roles were not observed opening today,
        # so they get their own type; date is observation time, published_at
        # carries the real feed timestamp.
        events = [make_event("initialized", slug, ats, job, now_iso) for job in cur_jobs]

    events.sort(key=lambda e: (e["type"] != "closed", e["published_at"], e["title"]))

    # Rewrite the snapshot when the jobs changed, or to clear a prior feed_error on recovery.
    # (Otherwise a no-op poll would bump fetched_at and make an empty daily commit.)
    if prev_jobs is None or cur_jobs != prev_jobs or had_error:
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
    outages = []
    all_locations = []
    for cfg in companies:
        try:
            result = run_company(cfg, now)
            all_locations.extend(result.get("locations", []))
            if result.get("feed_error"):   # handled outage: flagged on the dashboard, not a run failure
                outages.append(f"{result['slug']} ({result['feed_error']})")
        except Exception as exc:  # an unexpected error (our bug) — fail the run so we notice
            failures.append(f"{cfg.get('slug', '?')}: {exc}")
            print(f"  {cfg.get('slug', '?')}: FAILED — {exc}", file=sys.stderr)

    geocode_new_locations(all_locations)   # one pass over the shared cache for the whole poll
    write_company_index(companies)

    if outages:
        print(f"{len(outages)} feed(s) unavailable, flagged on dashboard: {', '.join(outages)}",
              file=sys.stderr)
    if failures:
        print(f"{len(failures)} company poll(s) failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
