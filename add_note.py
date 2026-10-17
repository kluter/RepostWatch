#!/usr/bin/env python3
"""Append a manual first-seen note for a role lineage to a company's event log.

For knowledge the feed can't show — e.g. a role observed on LinkedIn months
before tracking began. The dashboard's severity rules use the earliest of the
tracked publish date and any noted first_seen, so long-lingering roles get
flagged honestly, with the claim recorded as its own event.

    python add_note.py iceye --title "Forward Deployed Geospatial Engineer - SAR Intelligence, Berlin" \\
        --location Berlin --first-seen 2026-02-01 --source linkedin_observation
"""

import argparse
import json
from datetime import date, datetime, timezone

from poll import DATA_DIR, make_lineage_key


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("company", help="company slug, e.g. iceye")
    p.add_argument("--title", required=True, help="exact posting title (used for the lineage key)")
    p.add_argument("--location", required=True, help="posting location (used for the lineage key)")
    p.add_argument("--first-seen", required=True, help="ISO date the role was first observed, e.g. 2026-02-01")
    p.add_argument("--source", required=True, help="e.g. linkedin_observation")
    p.add_argument("--note", default="", help="optional free-text remark")
    args = p.parse_args()

    try:
        date.fromisoformat(args.first_seen)
    except ValueError:
        raise SystemExit(f"--first-seen {args.first_seen!r} is not an ISO date (e.g. 2026-02-01)")

    events_path = DATA_DIR / args.company / "events.jsonl"
    if not events_path.parent.is_dir():
        raise SystemExit(f"unknown company {args.company!r}: no {events_path.parent} directory")

    ev = {
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "type": "noted_manual",
        "company": args.company,
        "title": args.title,
        "location": args.location,
        "lineage_key": make_lineage_key(args.title, args.location),
        "first_seen": args.first_seen,
        "source": args.source,
    }
    if args.note:
        ev["note"] = args.note
    with events_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    print(f"appended to {events_path}:\n{json.dumps(ev, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
