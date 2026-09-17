#!/usr/bin/env python3
"""Acme AI — a pretend product that bills its customers with Metronome.

    python app.py bugs                               # list the bugs you can switch on
    python app.py send --calls 20                    # correct integration
    python app.py send --calls 20 --bug lowercase-region
    python app.py send --bug price-dispute --calls 0 # ticket-only scenario

Every send writes last_run.json, which Billing Doctor reads:
    npm run doctor -- triage --live --txn-file demo-app/last_run.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from emitter import BUGS, Config, build_traffic

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")


def cmd_bugs(_: argparse.Namespace) -> int:
    for name, bug in BUGS.items():
        print(f"{name:18} {bug.description}")
    return 0


def cmd_send(args: argparse.Namespace) -> int:
    from metronome import APIError, Metronome  # imported here so `bugs` works without the SDK

    cfg = Config(
        alias=os.environ.get("DEMO_CUSTOMER_ALIAS", "acme-123"),
        external_id=os.environ.get("DEMO_CUSTOMER_EXTERNAL_ID", "acme-prod"),
    )
    events = build_traffic(cfg, args.calls, args.bug)
    base_url = os.environ.get("METRONOME_BASE_URL", "https://api.metronome.com")
    print(f"Sending {len(events)} event(s) to {base_url} with bug={args.bug}")

    errors: list[str] = []
    if events:
        client = Metronome()  # reads METRONOME_BEARER_TOKEN and METRONOME_BASE_URL
        for i in range(0, len(events), 100):  # API limit: 100 events per request
            batch = events[i : i + 100]
            try:
                client.v1.usage.ingest(usage=batch)
            except APIError as e:
                status = getattr(e, "status_code", "?")
                msg = f"batch {i // 100}: HTTP {status}: {e}"
                errors.append(msg)
                print(f"  ! {msg}", file=sys.stderr)

    bug = BUGS[args.bug]
    report = {
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "base_url": base_url,
        "bug": args.bug,
        "customer_id": os.environ.get("DEMO_CUSTOMER_ID", "cust_acme"),
        "customer_alias": cfg.alias,
        "events_sent": len(events),
        "ingest_errors": errors,
        # Unique IDs; duplicates (reuse-txn-id) collapse to one, which is the point.
        "transaction_ids": list(dict.fromkeys(e["transaction_id"] for e in events)),
        "ticket_subject": bug.ticket_subject,
        "ticket_body": bug.ticket_body,
        **({"invoice": bug.invoice} if bug.invoice else {}),
    }
    out = HERE / "last_run.json"
    out.write_text(json.dumps(report, indent=2))
    print(f"Wrote {out.name}: {len(report['transaction_ids'])} transaction id(s), {len(errors)} ingest error(s)")
    print("Next: npm run doctor -- triage --live --txn-file demo-app/last_run.json")
    return 1 if errors else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("bugs", help="list available bugs").set_defaults(func=cmd_bugs)
    s = sub.add_parser("send", help="simulate API traffic and send usage")
    s.add_argument("--calls", type=int, default=10, help="simulated API calls (2 events each)")
    s.add_argument("--bug", choices=list(BUGS), default="none")
    s.set_defaults(func=cmd_send)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
