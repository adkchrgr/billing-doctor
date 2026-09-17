# Milestone 1: Agentic Loop Notes

## How the loop decides what to do next (`src/agent/loop.ts`)

Each turn, the model returns a `stop_reason`. **The loop, not the model, decides whether to continue.**

| Situation | Loop decision | Course concept |
|---|---|---|
| `stop_reason = tool_use` | Run each tool (through hooks), send the results back, go again | The core agentic loop |
| Model calls `submit_diagnosis` with a valid payload | **Stop**: `diagnosis_submitted` | Explicit termination tool instead of "the model went quiet" |
| `submit_diagnosis` fails validation | Return `is_error` with the reason; the model retries | Validate structured output and let the model fix it |
| Confidence < 0.6 on a "root cause found" | Stop, but **downgrade to `needs_human`** | Deterministic policy beats model self-assessment |
| `stop_reason = end_turn` with no tool call | Nudge once ("call submit_diagnosis"); second time → **stop** `no_diagnosis` | Handle the model ending early; don't loop forever |
| Same read-only call made again | Serve the cached result and tell the model it's a repeat | Cut wasted calls without trusting the prompt alone |
| Write tool, not approved | Blocked by hook, returned as an error the model can reason about | Hooks / human-in-the-loop |
| Turn count > `maxTurns` (12) | **Stop** `max_turns` | Hard safety limit |
| Tokens > `tokenBudget` (150k) | **Stop** `token_budget` | Cost limit (every call is billed via Metronome) |

Key idea: the model *proposes* (which tool, when it's done, how confident it is). Code *decides* anything with a cost, risk, or policy attached.

## Change made in this milestone: cutting wasted tool calls

Two layers, because prompts are suggestions and code is enforcement:

1. **Prompt (`src/agent/prompt.ts`):** tells the model that `run_event_checks` already fetches events, customers, and metrics; to call each tool once; to batch independent lookups in one turn; and that a typical ticket needs 1–2 evidence calls.
2. **Loop:** identical read-only calls are answered from cache (the scripted test drops 3 Metronome queries to 1). Low-confidence answers are routed to a human.

The loop now reports `tool_calls`, `duplicate_calls`, `blocked_calls`, `invalid_diagnoses`, `nudges`, and `confidence_override`.

## Measuring it with a real model

```bash
export ANTHROPIC_API_KEY=...        # a few cents of usage for the full set
git stash                           # optional: measure the old prompt first
npm run doctor -- eval --agent --label before
git stash pop
npm run doctor -- eval --agent --label after
# compare runs/eval-agent-before.json vs runs/eval-agent-after.json:
#   pass count (must not drop), turns, tool_calls, duplicate_calls, tokens
```

What to look for:
- **healthy**: should be 1 evidence call → `no_issue_found`. Extra calls here mean the model is over-investigating.
- **reused-txn-id**: ideally `run_event_checks` + `list_invoices`/`check_invoice` in the **same** turn.
- **price-override**: no transaction IDs, so it should skip event checks entirely.

## No API key? Use your Claude plan through MCP

```bash
cd ~/Projects/billing-doctor
claude            # Claude Code picks up .mcp.json → billing-doctor server
```
Then ask: *"Use billing-doctor tools to find out why transactions rc1 and rc2 aren't billing, then draft the customer reply."*
Change `BD_SCENARIO` in `.mcp.json` to try another ticket. Here Claude Code runs the loop, so compare how its stop decisions differ from ours.
