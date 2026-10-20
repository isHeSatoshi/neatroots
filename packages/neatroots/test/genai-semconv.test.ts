import { describe, expect, it } from "vitest";
import { buildView } from "../src/semantics/view.js";
import { loadTrace, toolsOffered } from "../src/engine/trace.js";
import { batch, hex, makeRoots, span, s, until } from "./helpers.js";

// pydantic-ai's own OpenTelemetry instrumentation sends modern GenAI-semconv spans. neatroots read
// the hierarchy, model, per-call tokens, messages, tool calls and session id already, but left the
// run's previews empty, listed only the tools that were called, and showed no tokens on the agent
// span. The attribute values below are from a real run of examples/python-pydanticai against the
// mock LLM (pydantic-ai 2.57.0), copied as captured.

const TOOL_DEFINITIONS =
  '[{"type":"function","name":"lookup_order","description":"Look up an order by its id.","parameters":{"additionalProperties":false,"properties":{"order_id":{"type":"string"}},"required":["order_id"],"type":"object"}},{"type":"function","name":"issue_refund","description":"Refund an order.","parameters":{"additionalProperties":false,"properties":{"order_id":{"type":"string"},"amount":{"type":"number"}},"required":["order_id","amount"],"type":"object"}}]';

const ALL_MESSAGES =
  '[{"role":"system","parts":[{"type":"text","content":"You are a support agent."}]},{"role":"user","parts":[{"type":"text","content":"Please refund order 1001"}]},{"role":"assistant","parts":[{"type":"tool_call","id":"call_e5fa0b3c","name":"issue_refund","arguments":"{\\"order_id\\":\\"1001\\",\\"amount\\":1}"}],"finish_reason":"tool_call"},{"role":"user","parts":[{"type":"tool_call_response","id":"call_e5fa0b3c","name":"issue_refund","result":"{\\"refunded\\": 1.0, \\"order_id\\": \\"1001\\"}"}]},{"role":"assistant","parts":[{"type":"text","content":"Here\'s what I found: {\\"refunded\\": 1.0, \\"order_id\\": \\"1001\\"}"}],"finish_reason":"stop"}]';

const FINAL_RESULT = 'Here\'s what I found: {"refunded": 1.0, "order_id": "1001"}';

/** An `invoke_agent` span as pydantic-ai sends it: no input/output attributes, only these. */
function agentSpan(traceId: string, attrs: ReturnType<typeof s>[] = []) {
  const sp = span({ traceId, name: "invoke_agent agent", kind: "x" });
  sp.attributes = [
    s("gen_ai.operation.name", "invoke_agent"),
    s("gen_ai.agent.name", "agent"),
    s("gen_ai.aggregated_usage.input_tokens", 80),
    s("gen_ai.aggregated_usage.output_tokens", 20),
    s("model_name", "gpt-4o-mini"),
    s("pydantic_ai.all_messages", ALL_MESSAGES),
    s("final_result", FINAL_RESULT),
    ...attrs,
  ];
  return sp;
}

/** A `chat` span as pydantic-ai sends it, with the two tools offered on it. */
function chatSpan(traceId: string, parent: string) {
  const sp = span({ traceId, parent, name: "chat gpt-4o-mini", kind: "x" });
  sp.attributes = [
    s("gen_ai.operation.name", "chat"),
    s("gen_ai.request.model", "gpt-4o-mini"),
    s("gen_ai.response.model", "gpt-4o-mini"),
    s("gen_ai.usage.input_tokens", 40),
    s("gen_ai.usage.output_tokens", 5),
    s("gen_ai.tool.definitions", TOOL_DEFINITIONS),
    s("gen_ai.input.messages", '[{"role":"user","parts":[{"type":"text","content":"Please refund order 1001"}]}]'),
    s("gen_ai.output.messages", '[{"role":"assistant","parts":[{"type":"tool_call","id":"call_e5fa0b3c","name":"issue_refund","arguments":"{\\"order_id\\":\\"1001\\",\\"amount\\":1}"}]}]'),
  ];
  return sp;
}

describe("the attributes pydantic-ai's GenAI spans carry", () => {
  it("reads the run's input and output from the agent span, so the previews are not empty", () => {
    const v = buildView(agentSpan(hex(16)), []);
    expect(v.kind).toBe("AGENT");
    expect(v.input).toEqual([{ role: "user", content: "Please refund order 1001" }]); // the first user turn, not the tool result after it
    expect(v.output).toBe(FINAL_RESULT); // final_result
  });

  it("reads the agent span's own token counts from gen_ai.aggregated_usage", () => {
    const v = buildView(agentSpan(hex(16)), []);
    expect(v.promptTokens).toBe(80);
    expect(v.completionTokens).toBe(20);
    expect(v.totalTokens).toBe(100);
  });

  it("keeps a per-call count when a span carries both forms", () => {
    // A span can have the agent's aggregate and one call's own count; the call's is the specific
    // one, so the aggregate stays the fallback.
    const sp = agentSpan(hex(16), [s("llm.token_count.prompt", 12), s("llm.token_count.completion", 3)]);
    const v = buildView(sp, []);
    expect(v.promptTokens).toBe(12);
    expect(v.completionTokens).toBe(3);
    expect(v.totalTokens).toBe(15);
  });

  it("lists tools that were offered but never called", () => {
    const v = buildView(chatSpan(hex(16), hex(8)), []);
    expect(v.kind).toBe("LLM");
    // Both were offered; only issue_refund was called, so the old reader showed one tool.
    expect(v.tools).toEqual(["lookup_order", "issue_refund"]);
    // The call itself already read from the output messages; this change does not touch it.
    expect(JSON.stringify(v.output)).toContain("issue_refund");
  });

  it("keeps the SDK's own tool list when a span has both forms", () => {
    const sp = chatSpan(hex(16), hex(8));
    sp.attributes.push(s("neatlogs.llm.tools.0.name", "lookup_order"), s("neatlogs.llm.tools.1.name", "issue_refund"));
    expect(buildView(sp, []).tools).toEqual(["lookup_order", "issue_refund"]);
  });

  it("leaves an input that names itself alone", () => {
    const sp = agentSpan(hex(16), [s("neatlogs.agent.input", "Refund order 1001")]);
    expect(buildView(sp, []).input).toBe("Refund order 1001");
  });

  it("does not read a tool result as the request", () => {
    const sp = agentSpan(hex(16));
    const only = JSON.parse(ALL_MESSAGES) as unknown[];
    // A conversation resumed from a tool result has no request turn of its own.
    sp.attributes = sp.attributes.map((a) => (a.key === "pydantic_ai.all_messages" ? s(a.key, JSON.stringify(only.slice(3, 4))) : a));
    expect(buildView(sp, []).input).toBeUndefined();
  });
});

describe("a run of those spans", () => {
  it("lands with the previews, the offered tools and the agent's tokens filled in", async () => {
    const tb = await makeRoots({ noEngine: true });
    try {
      const t = hex(16);
      const root = hex(8);
      tb.roots.ingest([
        batch([agentSpan(t, [s("neatlogs.workflow_name", "test-agent")])], "example-pydanticai"),
        batch([chatSpan(t, root)], "example-pydanticai"),
      ]);
      const run = await until(() => tb.roots.store.getRun(t));
      expect(run.input_preview).toContain("Please refund order 1001");
      expect(run.output_preview).toContain("Here's what I found");

      const snap = loadTrace(tb.roots.store, t);
      expect(toolsOffered(snap)).toEqual(["lookup_order", "issue_refund"]);
      const agent = snap.spans.find((sp) => sp.kind === "AGENT")!;
      expect(agent.tokens).toBe(100);
    } finally {
      await tb.close();
    }
  });
});
