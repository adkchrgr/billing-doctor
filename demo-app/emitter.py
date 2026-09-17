"""Builds usage events for "Acme AI", a pretend AI API product.

Each BUG reproduces a real-world integration mistake. The event-building logic
is pure (no network) so it can be unit-tested; app.py does the sending.
"""
from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


@dataclass(frozen=True)
class Bug:
    description: str
    ticket_subject: str
    ticket_body: str
    invoice: dict[str, Any] | None = None


BUGS: dict[str, Bug] = {
    "none": Bug(
        "Correct integration.",
        "Can you confirm our usage is landing?",
        "We just shipped a release. Can you confirm the events we sent are being billed?",
    ),
    "wrong-alias": Bug(
        "Sends the app's internal account key (external_id) instead of the ingest alias.",
        "Usage dropped to zero after our deploy",
        "We refactored how we look up the customer key and now Metronome shows no usage.",
    ),
    "event-type-typo": Bug(
        "Sends event_type 'api_requests' (plural) instead of 'api_request'.",
        "API request counts stopped increasing",
        "Ingest returns 200 but request counts haven't moved since our refactor.",
    ),
    "lowercase-region": Bug(
        "Sends region 'us'/'eu' instead of 'US'/'EU'.",
        "Token usage missing",
        "Token usage isn't showing up since we normalized our config values.",
    ),
    "renamed-tokens": Bug(
        "Renames the 'tokens' property to 'token_count'.",
        "Token totals are zero",
        "We upgraded our SDK wrapper and token usage dropped to zero.",
    ),
    "string-tokens": Bug(
        "Sends tokens as a string like '1200 tokens' instead of a number.",
        "Token totals look wrong",
        "Token usage is registering but the totals don't add up.",
    ),
    "reuse-txn-id": Bug(
        "Uses one transaction_id per customer per day, so Metronome drops repeats as duplicates.",
        "Far fewer requests billed than we sent",
        "Our logs show many more requests than Metronome counts today.",
    ),
    "seconds-timestamp": Bug(
        "Treats a Unix time in seconds as milliseconds, producing 1970 timestamps.",
        "Backfilled events never appeared",
        "We backfilled a batch of usage and none of it shows up.",
    ),
    "price-dispute": Bug(
        "Events are fine; the customer disputes the August token price instead.",
        "Overcharged on tokens",
        "Our contract says tokens are $0.0008/unit starting August, but the August invoice used $0.001.",
        invoice={"line_item_name": "Tokens", "expected_unit_price": 0.0008},
    ),
}


@dataclass
class Config:
    alias: str
    external_id: str
    now: Callable[[], datetime] = field(default=lambda: datetime.now(timezone.utc))
    rng: random.Random = field(default_factory=random.Random)


def _timestamp(cfg: Config, bug: str) -> str:
    now = cfg.now()
    if bug == "seconds-timestamp":
        unix_seconds = now.timestamp()
        # BUG: code believes the value is in milliseconds
        return datetime.fromtimestamp(unix_seconds / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return now.isoformat().replace("+00:00", "Z")


def _txn_id(cfg: Config, bug: str, kind: str) -> str:
    if bug == "reuse-txn-id":
        return f"{cfg.alias}-{kind}-{cfg.now():%Y-%m-%d}"  # BUG: not unique per occurrence
    return str(uuid.uuid4())


def build_request_events(cfg: Config, bug: str = "none") -> list[dict[str, Any]]:
    """One API call to Acme AI = one api_request event + one llm_completion event."""
    if bug not in BUGS:
        raise ValueError(f"unknown bug {bug!r}; choose from {', '.join(BUGS)}")

    customer_id = cfg.external_id if bug == "wrong-alias" else cfg.alias
    region = cfg.rng.choice(["US", "EU"])
    tokens = cfg.rng.randint(200, 4000)
    ts = _timestamp(cfg, bug)

    request = {
        "transaction_id": _txn_id(cfg, bug, "req"),
        "customer_id": customer_id,
        "event_type": "api_requests" if bug == "event-type-typo" else "api_request",
        "timestamp": ts,
        "properties": {"endpoint": "/v1/generate", "region": region},
    }

    props: dict[str, Any] = {"model": "acme-large", "region": region.lower() if bug == "lowercase-region" else region}
    if bug == "renamed-tokens":
        props["token_count"] = tokens
    elif bug == "string-tokens":
        props["tokens"] = f"{tokens} tokens"
    else:
        props["tokens"] = tokens

    completion = {
        "transaction_id": _txn_id(cfg, bug, "llm"),
        "customer_id": customer_id,
        "event_type": "llm_completion",
        "timestamp": ts,
        "properties": props,
    }
    return [request, completion]


def build_traffic(cfg: Config, calls: int, bug: str = "none") -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for _ in range(calls):
        events.extend(build_request_events(cfg, bug))
    return events
