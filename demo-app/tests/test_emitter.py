import random
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from emitter import BUGS, Config, build_request_events, build_traffic  # noqa: E402

NOW = datetime(2026, 9, 17, 12, 0, tzinfo=timezone.utc)


def cfg(seed=1):
    return Config(alias="acme-123", external_id="acme-prod", now=lambda: NOW, rng=random.Random(seed))


class EmitterTests(unittest.TestCase):
    def test_correct_integration(self):
        req, llm = build_request_events(cfg())
        self.assertEqual(req["customer_id"], "acme-123")
        self.assertEqual(req["event_type"], "api_request")
        self.assertIn(llm["properties"]["region"], ("US", "EU"))
        self.assertIsInstance(llm["properties"]["tokens"], int)
        self.assertEqual(req["timestamp"], "2026-09-17T12:00:00Z")
        self.assertNotEqual(req["transaction_id"], llm["transaction_id"])

    def test_each_bug_changes_what_it_says(self):
        c = cfg()
        self.assertEqual(build_request_events(c, "wrong-alias")[0]["customer_id"], "acme-prod")
        self.assertEqual(build_request_events(c, "event-type-typo")[0]["event_type"], "api_requests")
        self.assertIn(build_request_events(c, "lowercase-region")[1]["properties"]["region"], ("us", "eu"))
        self.assertIn("token_count", build_request_events(c, "renamed-tokens")[1]["properties"])
        self.assertIsInstance(build_request_events(c, "string-tokens")[1]["properties"]["tokens"], str)
        self.assertTrue(build_request_events(c, "seconds-timestamp")[0]["timestamp"].startswith("1970-01-21"))

    def test_reused_ids_collide_across_calls(self):
        events = build_traffic(cfg(), 5, "reuse-txn-id")
        self.assertEqual(len(events), 10)
        self.assertEqual(len({e["transaction_id"] for e in events}), 2)

    def test_unknown_bug_rejected(self):
        with self.assertRaises(ValueError):
            build_request_events(cfg(), "nope")

    def test_every_bug_has_a_ticket(self):
        for name, bug in BUGS.items():
            self.assertTrue(bug.ticket_subject and bug.ticket_body, name)


if __name__ == "__main__":
    unittest.main()
