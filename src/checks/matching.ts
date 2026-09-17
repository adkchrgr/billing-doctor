import type { BillableMetric, Customer, UsageEvent } from "../metronome/types.ts";

/** Approximates Metronome's matching rules; used by the mock AND to explain misses. */

export function resolveCustomer(customerRef: string, customers: Customer[]): Customer | undefined {
  return customers.find((c) => c.id === customerRef || c.ingest_aliases?.includes(customerRef));
}

export function eventTypeMatches(m: BillableMetric, eventType: string): boolean {
  const f = m.event_type_filter;
  if (!f) return true;
  if (f.in_values && !f.in_values.includes(eventType)) return false;
  if (f.not_in_values?.includes(eventType)) return false;
  return true;
}

export interface FilterFailure {
  filter: string;
  reason: "missing" | "should_not_exist" | "not_in_allowed" | "in_excluded";
  actual?: unknown;
  allowed?: string[];
}

/** Returns the first property filter the event fails, or null if all pass. */
export function failingPropertyFilter(m: BillableMetric, ev: UsageEvent): FilterFailure | null {
  const props = ev.properties ?? {};
  // A metric that aggregates on a key implicitly needs that key present.
  const filters = [...(m.property_filters ?? [])];
  if (m.aggregation_key && m.aggregation_type !== "count" && !filters.some((f) => f.name === m.aggregation_key)) {
    filters.push({ name: m.aggregation_key, exists: true });
  }
  for (const f of filters) {
    const has = Object.prototype.hasOwnProperty.call(props, f.name);
    const val = props[f.name];
    if (f.exists === true && !has) return { filter: f.name, reason: "missing" };
    if (f.exists === false && has) return { filter: f.name, reason: "should_not_exist", actual: val };
    if (f.in_values) {
      if (!has) return { filter: f.name, reason: "missing" };
      if (!f.in_values.includes(String(val))) return { filter: f.name, reason: "not_in_allowed", actual: val, allowed: f.in_values };
    }
    if (f.not_in_values && has && f.not_in_values.includes(String(val))) {
      return { filter: f.name, reason: "in_excluded", actual: val };
    }
  }
  return null;
}

export function metricMatches(m: BillableMetric, ev: UsageEvent): boolean {
  return !m.archived_at && eventTypeMatches(m, ev.event_type) && failingPropertyFilter(m, ev) === null;
}

/** Small edit distance for "did you mean" hints. */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

export function closest(target: string, options: string[], maxDist = 4): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = o.toLowerCase() === target.toLowerCase() ? 0 : editDistance(target.toLowerCase(), o.toLowerCase());
    if (d < bestD) [best, bestD] = [o, d];
  }
  return bestD <= maxDist ? best : undefined;
}
