import { afterEach, describe, expect, it } from "vitest";
import { loadTrace } from "../src/engine/trace.js";
import { buildChat } from "../src/semantics/chat-view.js";
import { currentRequest } from "../src/store/db.js";
import { batch, hex, llmSpan, makeRoots, s, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const msgAttrs = (prefix: string, msgs: { role: string; content?: string }[]) =>
  msgs.flatMap((m, i) => [s(`neatlogs.llm.${prefix}.${i}.role`, m.role), ...(m.content !== undefined ? [s(`neatlogs.llm.${prefix}.${i}.content`, m.content)] : [])]);

describe("a later turn of a chat session", () => {
  const history = [
    { role: "system", content: "You are a friendly travel assistant." },
    { role: "user", content: "Hi! I'm planning a trip to Lisbon." },
    { role: "assistant", content: "Lovely, when are you going?" },
    { role: "user", content: "What should I pack for October?" },
    { role: "assistant", content: "Layers and a light rain jacket." },
    { role: "user", content: "And one restaurant you'd recommend?" },
  ];

  it("is titled by the current request, not the history before it", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    const input = JSON.stringify({ history: history.slice(0, 5), text: "And one restaurant you'd recommend?" });
    t.roots.ingest([batch([span({ traceId: tid, spanId: root, name: "chat-turn", kind: "workflow", attrs: [s("neatlogs.workflow.input", input)] })])]);
    expect(t.roots.store.getRun(tid)!.input_preview).toBe("And one restaurant you'd recommend?");
    expect(currentRequest(history as never)).toBe("And one restaurant you'd recommend?");
  });

  it("shows the earlier turns as paired user and assistant history, then the current request", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    t.roots.ingest([
      batch([
        span({ traceId: tid, parent: root, name: "openai.chat.completions.create", kind: "llm", attrs: [s("neatlogs.llm.model_name", "mock"), ...msgAttrs("input_messages", history), ...msgAttrs("output_messages", [{ role: "assistant", content: "Try Taberna da Rua das Flores." }])] }),
        span({ traceId: tid, spanId: root, name: "chat-turn", kind: "workflow" }),
      ]),
    ]);
    const items = buildChat(loadTrace(t.roots.store, tid)).items.map((i) => [i.type, "history" in i && i.history ? "earlier" : "now", "text" in i ? i.text : ""]);
    expect(items).toEqual([
      ["system", "now", "You are a friendly travel assistant."],
      ["user", "earlier", "Hi! I'm planning a trip to Lisbon."],
      ["assistant", "earlier", "Lovely, when are you going?"],
      ["user", "earlier", "What should I pack for October?"],
      ["assistant", "earlier", "Layers and a light rain jacket."],
      ["user", "now", "And one restaurant you'd recommend?"],
      ["assistant", "now", "Try Taberna da Rua das Flores."],
    ]);
  });
});

describe("an agent step whose tool call the SDK didn't record", () => {
  it("reads the call from the tool span that ran next", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    const root = hex(8);
    t.roots.ingest([
      batch([
        span({ traceId: tid, parent: root, name: "openai.chat.completions.create", kind: "llm", attrs: [s("neatlogs.llm.model_name", "mock"), ...msgAttrs("input_messages", [{ role: "user", content: "I want a refund for order 1001" }]), ...msgAttrs("output_messages", [{ role: "assistant" }])] }),
        toolSpan(tid, root, "issue_refund", '{"order_id":"1001"}', '{"refunded":1.0}'),
        span({ traceId: tid, spanId: root, name: "Refunds agent", kind: "agent" }),
      ]),
    ]);
    const assistant = buildChat(loadTrace(t.roots.store, tid)).items.find((i) => i.type === "assistant");
    expect(assistant).toMatchObject({ inferred: true, tool_calls: [{ name: "issue_refund" }] });
  });
});

describe("a run whose root span is the llm call itself (#273)", () => {
  it("keeps the message roles and the recorded tool call", async () => {
    t = await makeRoots({ noEngine: true });
    const tid = hex(16);
    // No parent: the LLM call is the root of the run, as an SDK sends when nothing wraps it.
    t.roots.ingest([
      batch([
        llmSpan(tid, "", {
          system: "You are a refund agent.",
          user: "Refund order 4512",
          out: "Looking up the order.",
          toolCalls: [{ name: "lookup_order", args: '{"order_id":"4512"}' }],
        }),
      ]),
    ]);
    const items = buildChat(loadTrace(t.roots.store, tid)).items;

    // The walk only visits the root's children, so the root LLM never reached the message parser
    // and the fallback flattened system + user into one card with no tool call.
    expect(items.map((i) => i.type)).toEqual(["system", "user", "assistant"]);
    expect(items[0]).toMatchObject({ type: "system", text: "You are a refund agent." });
    expect(items[1]).toMatchObject({ type: "user", text: "Refund order 4512" });
    expect(items[2]).toMatchObject({ type: "assistant", text: "Looking up the order.", tool_calls: [{ name: "lookup_order" }] });
  });
});
