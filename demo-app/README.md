# Acme AI: demo app that bills with Metronome

A pretend AI API product that sends usage to Metronome with the official Python SDK (`metronome-sdk`). You can switch on realistic integration bugs, then have Billing Doctor diagnose them.

```
Acme AI (this app) ──usage──► Metronome (fake server or real sandbox) ◄──investigates── Billing Doctor
```

## Setup (once)

```bash
cd demo-app
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # defaults point at the local fake server
```

## Run the loop locally

Terminal 1 (project root):
```bash
npm run fake-metronome        # fake Metronome API on http://localhost:4010
```

Terminal 2:
```bash
cd demo-app && source .venv/bin/activate
python app.py bugs                                  # see what you can break
python app.py send --calls 20 --bug lowercase-region

cd ..
export METRONOME_BASE_URL=http://localhost:4010
npm run doctor -- triage --live --txn-file demo-app/last_run.json   # no-AI
npm run doctor -- agent  --live --txn-file demo-app/last_run.json   # Claude (needs ANTHROPIC_API_KEY)
```

`last_run.json` carries the transaction IDs, the Metronome customer ID, a realistic ticket for the bug, and any ingest errors, so Billing Doctor gets the same context a support engineer would.

Useful while testing:
- `curl localhost:4010/__fake/state` shows what the fake server holds
- `curl -XPOST localhost:4010/__fake/reset` starts fresh
- `curl -H 'Authorization: Bearer x' 'localhost:4010/v1/customers/cust_acme/invoices?status=DRAFT'` shows the live draft invoice, so you can see bugs losing revenue

## Bugs

| `--bug` | What the app does wrong | Billing Doctor should say |
|---|---|---|
| `none` | nothing | no issue found |
| `wrong-alias` | sends `acme-prod` (external_id) as customer_id | CUSTOMER_NOT_RESOLVED |
| `event-type-typo` | `api_requests` | EVENT_TYPE_NOT_MATCHED |
| `lowercase-region` | `region: "us"` | PROPERTY_FILTER_EXCLUDED |
| `renamed-tokens` | `token_count` instead of `tokens` | AGGREGATION_KEY_INVALID |
| `string-tokens` | `tokens: "1200 tokens"` | AGGREGATION_KEY_INVALID |
| `reuse-txn-id` | one transaction_id per day | DUPLICATE_TRANSACTION_ID |
| `seconds-timestamp` | seconds treated as ms → 1970 | TIMESTAMP_INVALID (the real API may reject these at ingest; the errors are passed along) |
| `price-dispute` | no event bug; customer disputes the August price | PRICING_OVERRIDE_DATE_MISMATCH |

## Switching to a real Metronome sandbox

1. Get sandbox access and an API token from Metronome. Use a personal email.
2. In `.env`: delete `METRONOME_BASE_URL` and set `METRONOME_BEARER_TOKEN` to the sandbox token.
3. `python setup_sandbox.py`: creates the Acme Robotics customer (alias `acme-123`) and the two billable metrics. Copy the printed `DEMO_CUSTOMER_ID` into `.env`.
4. In the Metronome UI, create products "API Requests" and "Tokens", a rate card (0.001 each), and a contract for Acme. For the pricing bug, add a $0.0008 Tokens override that starts a month late.
5. Send traffic exactly as above. For Billing Doctor use `unset METRONOME_BASE_URL; export METRONOME_API_KEY=<sandbox token>`.
6. Give Metronome a minute to process events before running Billing Doctor.

The fake server follows the SDK's paths and payloads, but it's an approximation of the real API. Expect differences in validation and processing delay.

## Tests

```bash
python -m unittest discover -s tests
```
