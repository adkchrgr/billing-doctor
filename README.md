# Billing Doctor 🩺

[![CI](https://github.com/adkchrgr/billing-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/adkchrgr/billing-doctor/actions/workflows/ci.yml)

An AI support agent that diagnoses **Metronome usage-billing integration problems**, and bills its own users **through Metronome**.

> "Our usage dropped to zero after a deploy." → Billing Doctor pulls the events, compares them to the billable metrics, and replies:
> *"Your emitter sends `region: "us"` but the Tokens metric only accepts `"US"`. Values are case-sensitive, so normalize the value before sending."*

## Why I built this

A lot of support engineering is working out why something that "returned 200" didn't do what the customer expected: SSO configs, API auth, integrations. That investigation follows a repeatable playbook, which makes it a good fit for an AI agent.

Usage-based billing has the same shape of problem, with money attached. Billing Doctor applies that support playbook to Metronome: gather evidence, run deterministic checks, let an agent reason over the results, and hand a human a root cause plus a ready-to-send reply. I'm also using it to put the Claude Certified Architect – Foundations material into practice: agent loops, tool design, hooks, MCP and evals.

## Why it exists

Usage-billing bugs don't show up as errors. Ingest returns `200`, and the usage just never lands on the invoice. Common causes are an unregistered ingest alias, a pluralized `event_type`, a case-sensitive property filter, a renamed aggregation key, reused `transaction_id`s, or timestamps in seconds instead of milliseconds. Price disputes have their own versions: a negotiated override entered with the wrong start date, or never entered at all. Billing Doctor finds these in seconds instead of an hour of manual event spelunking.

## Quick start

```bash
npm install
npm run doctor -- scenarios                          # list sandbox scenarios with planted bugs
npm run doctor -- triage --scenario region-case      # offline, deterministic, no keys needed
npm run doctor -- eval                               # score all scenarios (10/10)
npm test                                             # 27 tests, including the agent loop with a scripted model

# Claude agent mode (needs ANTHROPIC_API_KEY)
npm run doctor -- agent --scenario reused-txn-id
npm run doctor -- eval --agent

# Live Metronome account (use a SANDBOX key)
METRONOME_API_KEY=... npm run doctor -- triage --live --customer <id> --txn t1,t2 --subject "..."
```

### Full loop: a real app sending usage → Billing Doctor
`demo-app/` is a small Python product ("Acme AI") that sends usage with the official Metronome SDK. It has switchable integration bugs. Run it against the bundled fake Metronome server (`npm run fake-metronome`) or a real sandbox, then point Billing Doctor at the run:

```bash
npm run fake-metronome                                   # terminal 1
cd demo-app && python app.py send --calls 20 --bug wrong-alias && cd ..
METRONOME_BASE_URL=http://localhost:4010 npm run doctor -- triage --live --txn-file demo-app/last_run.json
```
See [demo-app/README.md](demo-app/README.md).

### Use it from Claude Code on a subscription (no API key)
`.mcp.json` registers the MCP server. Open this folder in Claude Code and ask:
*"Use billing-doctor to figure out why transaction rc1 isn't billing."*
Switch scenarios with `BD_SCENARIO` in `.mcp.json`. Writes stay blocked unless `BD_ALLOW_WRITES=1`.

## Architecture

```
ticket ──► agent loop (src/agent/loop.ts) ──► Claude
              │  ▲                              │ tool_use
              │  └──────── tool_result ◄────────┘
              ▼
         hooks (pre/post)  ── blocks writes without human approval, records trace
              ▼
         tools (src/agent/tools.ts) ── focused, JSON in/out, errors as data
              ▼
         checks (src/checks/*)  ── deterministic diagnostics (also used offline)
                                   findings.ts: events & invoices · pricing.ts: rebuilds price from contract + rate card
              ▼
         MetronomeClient ── HttpMetronomeClient (live / fake server) | MockMetronomeClient (scenarios)

demo-app (Python, metronome-sdk) ──usage──► fake-server.ts (localhost:4010) or real sandbox
              
         submit_diagnosis ── schema-validated structured output ── stop
              ▼
         metering (src/metering/meter.ts) ── 1 usage event per investigation → OUR Metronome
```

| CCAR-F concept | Where |
|---|---|
| Agentic loop and stop decisions | `src/agent/loop.ts`: submit / nudge-once / max turns / token budget |
| Tool design | `src/agent/tools.ts`: one job per tool, "when to use" descriptions. `explain_price` hides three API calls behind one question |
| Structured output and validation | `src/agent/diagnosis.ts`: JSON schema, plus validation and a retry on bad output |
| Hooks and guardrails | `src/agent/hooks.ts`: write tools need approval; read-only tenants |
| MCP | `src/mcp-server.ts` and `.mcp.json` |
| Prompt caching | cache breakpoints on the system prompt and tool list |
| Evals | `src/scenarios/` planted bugs, `npm run doctor -- eval` |
| Cost awareness | token usage metered per investigation into Metronome |

See **docs/M1-NOTES.md** for how the loop decides when to stop, **docs/PLAN.md** for milestones and **docs/BUSINESS.md** for how this gets sold.

*Not affiliated with Metronome.*
