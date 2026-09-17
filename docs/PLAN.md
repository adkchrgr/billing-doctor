# Build Plan

Milestones follow the CCAR-F course order, so each one exercises what you just learned. ✅ = included in this scaffold.

## M0 — Sandbox and ground truth ✅
- Mock Metronome that derives `matched_customer`, `matched_billable_metrics` and `is_duplicate` the way the real platform does
- 8 scenarios, each with a ticket, account state and an answer key (`planted`)
- Deterministic checks, `eval` command, 15 tests
- **Try:** add a 9th scenario (e.g. an archived metric, or an `unique` metric whose key is missing). Write the scenario first, watch the eval fail, then add the check.

## M1 — Agentic loop (course: *Agentic Loop Foundations*, where you are now) ✅ — see docs/M1-NOTES.md
- Hand-written loop in `src/agent/loop.ts`. Stop reasons: `diagnosis_submitted`, `no_diagnosis` (after one nudge), `max_turns`, `token_budget`
- **Try:** run `agent` on each scenario and read the trace. When does the model stop? Does it over-call tools on `healthy`? Tighten the prompt and compare turns and tokens.
- **Stretch:** add a "confidence < 0.6 → needs_human" rule inside the loop rather than trusting the model.

## M2 — Tool design and error handling ✅
- ✅ `explain_price`: rebuilds a line item's unit price from contract → rate card → overrides and names the cause (`PRICING_OVERRIDE_DATE_MISMATCH`, `PRICING_OVERRIDE_MISSING`, `PRICING_NO_CONTRACT`, or `PRICING_UNEXPLAINED` → human)
- ✅ `list_contracts` for follow-up questions; scenarios `price-override`, `missing-override`, and the `discount-applied` control
- Next tools: `get_usage` (batched usage for a window), `get_net_balance` for credit/commit questions, tiered-rate support in the pricing model
- Return **errors as data** and keep payloads small. Compare `search_events` (raw) with `run_event_checks` (distilled): the model does better with distilled output.
- **Try:** remove `run_event_checks` and see whether the model can still diagnose from raw events. Worth writing up.

## M3 — MCP ✅ (server)
- `src/mcp-server.ts` exposes the tools to Claude Code and Claude Desktop, so no API key is needed
- Next: a Zendesk MCP (or the existing connector) so the agent reads real tickets, plus a resource that serves Metronome docs snippets

## M4 — Multi-agent orchestration
- Coordinator → **Events specialist** (M0 checks) + **Pricing specialist** (contracts/invoices) + **Reply writer** (tone, no jargon)
- Use the Claude Agent SDK subagents; give each specialist a narrow tool list and its own context
- Measure: does splitting improve accuracy on mixed tickets (add a scenario with two bugs of different kinds)?

## M5 — Hooks, safety, audit
- Current: approval gate for writes and a read-only mode
- Add: a PII redaction hook on tool results, an append-only audit log of every tool call, and a per-tenant rate limit
- Mirror the policy as Claude Code hooks (`PreToolUse`) for the MCP path

## M6 — Real Metronome sandbox (local half ✅)
- ✅ `demo-app/`: Python product sending usage via `metronome-sdk`, with 9 switchable bugs and a `setup_sandbox.py`
- ✅ `src/fake-server.ts`: local Metronome API on the SDK's paths and payloads, with a live DRAFT invoice built from ingested events
- ✅ Building against the SDK caught a real mismatch: the API returns `aggregation_type` in UPPERCASE (now normalized)
- ⬜ Get real sandbox access, run `setup_sandbox.py`, and repeat the bug runs live

1. Create a Metronome sandbox account
2. Recreate the scenarios live: two customers, the two billable metrics, then send the broken events with a script
3. Run `triage --live` and `agent --live` against them
4. **Self-metering:** in a second sandbox (Billing Doctor's own billing):
   - Customer per tenant, with ingest alias = `BILLING_DOCTOR_TENANT`
   - Billable metrics on `billing_doctor_investigation`:
     - *Resolved investigations*: count, `outcome` ∈ [root_cause_found, no_issue_found]
     - *Deep investigations*: count, `mode` ∈ [agent]
     - *AI tokens*: sum of `total_tokens` (internal margin tracking)
   - Products + rate card that match docs/BUSINESS.md, a contract with a prepaid commit, and a spend threshold notification
   - Set `BILLING_DOCTOR_METERING_KEY` and watch invoices build up as you run investigations

## M7 — Product surface
- Small web app or Zendesk sidebar app: paste a ticket → diagnosis + draft reply → "insert reply"
- Multi-tenant: each tenant brings a Metronome key (store encrypted; read-only key recommended)
- **Integration Health Monitor**: a scheduled job samples recent events and alerts on new unmatched `event_type`s, duplicate spikes or alias drift. This is the recurring-revenue feature.

## M8 — Evals and cost in CI
- Offline eval on every push; agent eval nightly with a pass-rate threshold
- Track tokens per resolved ticket over time (the metering data already has this)

## Demo deliverables
- 2-minute demo video: broken ticket → diagnosis → Metronome invoice for the investigation
- Write-up: "What I learned building an agent that debugs billing" (stop conditions, distilled tools, eval results)
