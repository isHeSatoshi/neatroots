import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup() {
  const tb = await makeRoots({ serve: true });
  cleanup.push(() => tb.close());
  // Stand-in decision model: records the evidence it is asked to judge.
  const seen: string[] = [];
  (tb.roots.engine as unknown as { decisions: unknown }).decisions = {
    decide: async (text: string) => {
      seen.push(text);
      return { answers: { q: { probability: 0.9 } }, backend: "stub", model: "stub", latencyMs: 0 };
    },
  };
  return { tb, seen };
}

function run(tb: TestRoots) {
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { user: "Refund order 4512" }), toolSpan(t, root, "charge_card", "card 4242", undefined, "card declined")])]);
  const tool = tb.roots.store.getSpans(t, true).find((s) => s.name === "charge_card")!;
  return { t, toolId: tool.span_id };
}

// judge (MCP) and /api/steer/check (the steer hooks' check) take span ids or prefixes. One that
// isn't in the run used to be dropped silently, so the question was judged over no evidence.
describe("judge with span ids", () => {
  it("judges the spans a prefix names, in any case", async () => {
    const { tb, seen } = await setup();
    const { t, toolId } = run(tb);
    const r = await tb.roots.engine!.judge(t, "Did a tool call fail?", { spanIds: [toolId.slice(0, 8).toUpperCase()] });
    expect(r.evidence_span_ids).toEqual([toolId]);
    expect(seen[0]).toContain("card declined");
  });

  it("throws for a span id the run doesn't have, an ambiguous prefix or an empty id", async () => {
    const { tb, seen } = await setup();
    const { t } = run(tb);
    await expect(tb.roots.engine!.judge(t, "Did a tool call fail?", { spanIds: ["deadbeef"] })).rejects.toThrow(/no span deadbeef/);
    await expect(tb.roots.engine!.judge(t, "Did a tool call fail?", { spanIds: [""] })).rejects.toThrow(/empty span id/);
    const ids = tb.roots.store.getSpans(t, true).map((s) => s.span_id);
    // Two spans whose ids share a first character make a one-character prefix ambiguous, if there is one.
    const shared = ids.find((a, i) => ids.some((b, j) => i !== j && b[0] === a[0]));
    if (shared) await expect(tb.roots.engine!.judge(t, "Did a tool call fail?", { spanIds: [shared[0]] })).rejects.toThrow(/more than one span/);
    expect(seen).toEqual([]);
  });

  it("answers unknown on /api/steer/check instead of judging nothing", async () => {
    const { tb, seen } = await setup();
    const { t } = run(tb);
    const res = await fetch(`${tb.url}/api/steer/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trace_id: t, question: "Did a tool call fail?", span_ids: ["deadbeef"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ answer: "unknown", probability: null, evidence_span_ids: [] });
    expect(body.reason).toContain("no span deadbeef");
    expect(seen).toEqual([]);
  });
});

// An LLM span's messages are described with `latestMessages`, which leaves the system/developer
// instructions out because `buildEvidence` states them once at the start of the text. Narrowing the
// judge to a span therefore dropped the instructions entirely, and a question like "did the agent
// violate its instructions?" was asked without them.
describe("judge keeps the run's instructions", () => {
  const POLICY = "Never approve discount code SPECIAL_UNIQUE_4512.";

  /** A run whose only LLM call carries an instruction, in the role the caller names. */
  function runWithInstruction(tb: TestRoots, role: "system" | "developer") {
    const t = hex(16);
    const root = hex(8);
    const llm = span({
      traceId: t,
      parent: root,
      name: "openai.chat.completions.create",
      kind: "llm",
      attrs: [
        s("neatlogs.llm.model_name", "mock"),
        s("neatlogs.llm.token_count.total", "15"),
        s("neatlogs.llm.input_messages.0.role", role),
        s("neatlogs.llm.input_messages.0.content", POLICY),
        s("neatlogs.llm.input_messages.1.role", "user"),
        s("neatlogs.llm.input_messages.1.content", "Apply the discount."),
        s("neatlogs.llm.output_messages.0.role", "assistant"),
        s("neatlogs.llm.output_messages.0.content", "Discount approved."),
      ],
    });
    tb.roots.ingest([batch([llm])]);
    return { t, llmId: llm.spanId! };
  }

  it("includes it when a span is selected, for the system role", async () => {
    const { tb, seen } = await setup();
    const { t, llmId } = runWithInstruction(tb, "system");
    await tb.roots.engine!.judge(t, "Did the agent violate its instructions?", { spanIds: [llmId] });
    expect(seen[0]).toContain(POLICY);
    // The selected span's own evidence is still there, and is still the only span evidence.
    expect(seen[0]).toContain("Discount approved.");
  });

  it("includes it when a span is selected, for the developer role", async () => {
    const { tb, seen } = await setup();
    const { t, llmId } = runWithInstruction(tb, "developer");
    await tb.roots.engine!.judge(t, "Did the agent violate its instructions?", { spanIds: [llmId] });
    expect(seen[0]).toContain(POLICY);
  });

  it("includes it when the whole run is judged, as it always did", async () => {
    const { tb, seen } = await setup();
    const { t } = runWithInstruction(tb, "system");
    await tb.roots.engine!.judge(t, "Did the agent violate its instructions?");
    expect(seen[0]).toContain(POLICY);
  });

  it("states the instruction once, not again inside the selected span's messages", async () => {
    const { tb, seen } = await setup();
    const { t, llmId } = runWithInstruction(tb, "system");
    await tb.roots.engine!.judge(t, "Did the agent violate its instructions?", { spanIds: [llmId] });
    expect(seen[0].split(POLICY)).toHaveLength(2);
  });

  it("keeps the instruction out of the evidence span ids", async () => {
    const { tb } = await setup();
    const { t, llmId } = runWithInstruction(tb, "system");
    const r = await tb.roots.engine!.judge(t, "Did the agent violate its instructions?", { spanIds: [llmId] });
    expect(r.evidence_span_ids).toEqual([llmId]);
  });
});
