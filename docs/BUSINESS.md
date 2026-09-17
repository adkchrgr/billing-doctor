# Making Money with Billing Doctor

## The problem worth paying for
Companies moving to usage-based pricing hit a class of bug that doesn't throw errors: **usage that silently doesn't bill**, or bills wrong. Each one costs revenue (under-billing), trust (over-billing), and engineering hours (manual digging). Billing Doctor turns those hours into minutes, and it can catch the problem before the customer does.

## Who buys
| Buyer | Pain | What they buy |
|---|---|---|
| **Engineering / RevOps at companies on Metronome** | Silent revenue leakage, slow billing tickets | Health Monitor + investigations |
| **Their support teams** | Billing tickets need an engineer to answer | Zendesk/Intercom app with draft replies |
| **Billing implementation consultants / agencies** | Launch audits are manual | Audit licenses, white-label reports |
| **Billing platforms' own support orgs** | Ticket volume from integration mistakes | Enterprise license / partnership |

## Products (in order of revenue potential)

### 1. Integration Health Monitor (recurring, the core business)
Continuously samples a tenant's recent events and alerts on:
- new `event_type`s that match no metric
- events from unknown customer IDs or aliases
- duplicate-rate spikes, timestamp drift, and aggregation keys that disappear

It sells on **revenue recovered**: "We found 3.2% of your usage wasn't billing."

### 2. Investigations (usage-based)
Ticket in → root cause + ready-to-send reply out. Offline triage is cheap; agent investigations cost real tokens, so they're priced per resolution.

### 3. Launch Audit (one-time service)
A fixed-fee pre-launch review of a new pricing rollout: replay a sample of production events against the new metrics before go-live. It's a good way to land a customer, and it leads into the Monitor.

## Pricing (dogfooded on Metronome)
Illustrative starting point; validate with customers.

| Plan | Price | Includes | Overage |
|---|---|---|---|
| **Free** | $0 | Unlimited offline triage, 5 agent investigations/mo | — |
| **Pro** | $149/mo platform fee | 50 resolved investigations, Monitor on 1 environment | $2 per resolved investigation |
| **Team** | $599/mo | 250 resolved, Monitor on 3 environments, Zendesk app, write actions with approval | $1.50 per resolved |
| **Enterprise** | Annual contract, prepaid commit | SSO, audit log, custom checks, VPC option | Drawn down from commit |

**Pricing design choices:**
- **Outcome-based:** only `root_cause_found` / `no_issue_found` count. `needs_human` is free. The billable metric filters on `outcome`, so customers pay for results, not for attempts.
- **Platform fee + usage:** predictable base, upside with volume
- **Prepaid commits for Enterprise:** Metronome commits/credits with a balance threshold notification at 80% drawdown triggers a sales conversation
- **Margin guardrail:** `total_tokens` is metered too. If cost per resolution drifts above target, you see it on your own dashboard before it hits margins.

### Unit economics (rough; check current Claude API pricing)
- An agent investigation is about 4–8 turns. With prompt caching, the repeated system prompt and tools are billed at the cached rate. Expect cents to low tens of cents per investigation on a mid-tier model.
- At $1.50–$2 per resolution, gross margin is healthy even at 2–3× the expected token use.
- Offline triage costs almost nothing, which is why it's free and unlimited. It's the top of the funnel.

## Go-to-market
1. **Open-source the offline checker** (this repo's `checks/` and the CLI). Developers find it when they search for "Metronome events not showing up."
2. **Content:** "The 8 silent usage-billing bugs" post, built straight from the scenario set
3. **Integrations marketplace:** Zendesk and Intercom app listings; apply to Metronome's partner program if one is available
4. **Design partners:** 3–5 companies get free Team plans in exchange for real (anonymized) tickets, which become new eval scenarios
5. **Expand the platform list:** the `MetronomeClient` interface is the seam. Adapters for other usage-billing platforms widen the market.

## Risks and how to handle them
- **The platform builds this natively.** Stay multi-platform, and go deeper on support workflow (Zendesk, reply drafting) than a billing vendor will.
- **Customer API keys are sensitive.** Recommend read-only keys, encrypt at rest, keep write tools off by default and approval-gated (already built).
- **Niche market.** The Monitor and multi-platform adapters widen it, and the consulting/audit service brings revenue early.

*Billing Doctor is an independent project, not affiliated with Metronome. This isn't legal or financial advice.*
