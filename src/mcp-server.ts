#!/usr/bin/env -S npx tsx
/**
 * MCP server: exposes Billing Doctor's tools to Claude Code / Claude Desktop,
 * so you can run investigations on a Claude subscription with no API key.
 *
 *   BD_SCENARIO=region-case npx tsx src/mcp-server.ts      # sandbox scenario
 *   METRONOME_API_KEY=... npx tsx src/mcp-server.ts        # live (sandbox key!)
 *
 * The same hook policy applies: write tools are refused unless BD_ALLOW_WRITES=1.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildTools } from "./agent/tools.ts";
import { createHooks } from "./agent/hooks.ts";
import { MockMetronomeClient } from "./metronome/mock.ts";
import { HttpMetronomeClient, type MetronomeClient } from "./metronome/client.ts";
import { getScenario } from "./scenarios/index.ts";

let mc: MetronomeClient;
let now = new Date();
if (process.env.METRONOME_API_KEY && !process.env.BD_SCENARIO) {
  mc = new HttpMetronomeClient(process.env.METRONOME_API_KEY);
} else {
  const s = getScenario(process.env.BD_SCENARIO ?? "healthy");
  mc = new MockMetronomeClient(s.world);
  now = new Date(s.now);
}

// submit_diagnosis is only meaningful inside our own loop; in MCP the host model just answers.
const tools = buildTools(mc, now).filter((t) => t.name !== "submit_diagnosis");
const hooks = createHooks({ approver: async () => process.env.BD_ALLOW_WRITES === "1" });

const server = new Server({ name: "billing-doctor", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema as { type: "object" },
    annotations: { readOnlyHint: !t.mutating, destructiveHint: t.mutating },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const def = tools.find((t) => t.name === req.params.name);
  if (!def) return { isError: true, content: [{ type: "text", text: `Unknown tool ${req.params.name}` }] };
  const input = req.params.arguments ?? {};
  const gate = await hooks.preToolUse(def, input);
  if (!gate.allow) return { isError: true, content: [{ type: "text", text: gate.reason }] };
  try {
    const out = await def.run(input);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e) }] };
  }
});

await server.connect(new StdioServerTransport());
