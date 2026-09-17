/**
 * Hook layer: deterministic policy that runs around every tool call.
 * The model can *ask* for anything; hooks decide what actually executes.
 */
export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  ms: number;
  blocked?: string;
}

export type Approver = (tool: string, input: unknown) => Promise<boolean>;

export interface Hooks {
  preToolUse(tool: { name: string; mutating: boolean }, input: unknown): Promise<{ allow: true } | { allow: false; reason: string }>;
  postToolUse(rec: ToolCallRecord): void;
  trace: ToolCallRecord[];
}

export function createHooks(opts: { approver: Approver; readOnly?: boolean }): Hooks {
  const trace: ToolCallRecord[] = [];
  return {
    trace,
    async preToolUse(tool, input) {
      if (!tool.mutating) return { allow: true };
      if (opts.readOnly) return { allow: false, reason: "Read-only mode: write actions are disabled for this tenant." };
      const ok = await opts.approver(tool.name, input);
      return ok ? { allow: true } : { allow: false, reason: "A human reviewer declined this action. Recommend it in the diagnosis instead." };
    },
    postToolUse(rec) {
      trace.push(rec);
    },
  };
}

/** Non-interactive default: never approve writes. */
export const denyAll: Approver = async () => false;
