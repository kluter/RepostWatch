#!/usr/bin/env python3
"""Append a manual headcount observation to a company's event log.

Headcount is never automated (see README); this just keeps hand-entered
lines well-formed.

    python add_headcount.py iceye 720 --source revelio
    python add_headcount.py iceye 750 --source linkedin_estimate --date 2026-07-01
"""

import argparse
import json
from datetime import datetime, timezone

from poll import DATA_DIR, parse_ts


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("company", help="company slug, e.g. iceye")
    p.add_argument("value", type=int, help="headcount figure")
    p.add_argument("--source", required=True, help="e.g. revelio, linkedin_estimate")
    p.add_argument("--date", help="ISO date of the observation (default: now, UTC)")
    args = p.parse_args()

    if args.value <= 0:
        raise SystemExit(f"headcount must be a positive number, got {args.value}")
    if args.date:
        date = args.date if "T" in args.date else args.date + "T00:00:00+00:00"
        if parse_ts(date) is None:
            raise SystemExit(f"--date {args.date!r} is not an ISO date (e.g. 2026-07-01)")
    else:
        date = datetime.now(timezone.utc).isoformat(timespec="seconds")

    events_path = DATA_DIR / args.company / "events.jsonl"
    if not events_path.parent.is_dir():
        raise SystemExit(f"unknown company {args.company!r}: no {events_path.parent} directory")

    ev = {
        "date": date,
        "type": "headcount_manual",
        "company": args.company,
        "value": args.value,
        "source": args.source,
    }
    with events_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")
    print(f"appended to {events_path}:\n{json.dumps(ev, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
