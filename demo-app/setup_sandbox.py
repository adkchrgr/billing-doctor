#!/usr/bin/env python3
"""Creates the demo customer and billable metrics in a Metronome account.

Safe to re-run: skips anything that already exists (matched by name).
Works against the fake server too. Contracts, products and the rate card
are set up in the Metronome UI; see README.md.
"""
from __future__ import annotations

import os

from dotenv import load_dotenv
from metronome import Metronome

load_dotenv()

CUSTOMER = {
    "name": "Acme Robotics",
    "external_id": os.environ.get("DEMO_CUSTOMER_EXTERNAL_ID", "acme-prod"),
    "ingest_aliases": [os.environ.get("DEMO_CUSTOMER_ALIAS", "acme-123")],
}

METRICS = [
    {
        "name": "API Requests",
        "aggregation_type": "COUNT",
        "event_type_filter": {"in_values": ["api_request"]},
    },
    {
        "name": "Tokens",
        "aggregation_type": "SUM",
        "aggregation_key": "tokens",
        "event_type_filter": {"in_values": ["llm_completion"]},
        "property_filters": [{"name": "region", "exists": True, "in_values": ["US", "EU"]}],
        "group_keys": [["region"]],
    },
]


def main() -> None:
    client = Metronome()

    existing_customers = {c.name: c for c in client.v1.customers.list()}
    if CUSTOMER["name"] in existing_customers:
        customer_id = existing_customers[CUSTOMER["name"]].id
        print(f"customer exists: {CUSTOMER['name']} ({customer_id})")
    else:
        customer_id = client.v1.customers.create(**CUSTOMER).data.id
        print(f"created customer: {CUSTOMER['name']} ({customer_id})")

    existing_metrics = {m.name for m in client.v1.billable_metrics.list()}
    for metric in METRICS:
        if metric["name"] in existing_metrics:
            print(f"metric exists: {metric['name']}")
            continue
        created = client.v1.billable_metrics.create(**metric)
        print(f"created metric: {metric['name']} ({created.data.id})")

    print(f"\nSet DEMO_CUSTOMER_ID={customer_id} in demo-app/.env")


if __name__ == "__main__":
    main()
