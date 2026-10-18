import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, mockLlm, span, until, type TestRoots } from "./helpers.js";

// A JSON field of the wrong type is not a smaller version of the right one: `"false"` is truthy, a
// number has no `.trim()`, and an object is not an id. These routes used to answer with a 500 and a
// raw TypeError, or with 200 and the opposite of what was asked (#304, #316, #318, #419, #421,
// #423, #425, #437, #438).

let t: TestRoots | undefined;
let llm: Awaited<ReturnType<typeof mockLlm>> | undefined;
afterEach(async () => {
  await t?.close();
  await llm?.close();
  t = undefined;
  llm = undefined;
});

async function serve(opts: { engine?: boolean; llm?: boolean } = {}): Promise<{ url: string; post: (path: string, body: unknown) => Promise<Response>; get: (path: string) => Promise<Response> }> {
  if (opts.llm) llm = await mockLlm();
  t = await makeRoots({ noEngine: !opts.engine, serve: true, llmUrl: opts.llm ? llm!.url : undefined });
  const headers = { "content-type": "application/json", origin: t.url.replace("127.0.0.1", "localhost") };
  return {
    url: t.url,
    post: (path, body) => fetch(`${t!.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    get: (path) => fetch(`${t!.url}${path}`, { headers }),
  };
}

/** The error message a 400 carried, for asserting it names the field rather than a TypeError. */
async function refusal(res: Response): Promise<string> {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: string }).error;
}

describe("a boolean field must be a JSON boolean", () => {
  it("refuses a string in place of the run's pinned flag, and still pins and unpins (#318)", async () => {
    const { post } = await serve();
    const traceId = hex(16);
    const root = hex(8);
    t!.roots.ingest([batch([span({ traceId, spanId: root, name: "refund", kind: "workflow" })])]);
    await until(() => t!.roots.store.getRun(traceId));

    expect(await refusal(await post(`/api/runs/${traceId}/pin`, { pinned: "false" }))).toBe("pinned must be true or false");
    expect(t!.roots.store.getRun(traceId)!.pinned).toBe(0); // nothing changed

    expect((await post(`/api/runs/${traceId}/pin`, { pinned: true })).status).toBe(200);
    expect(t!.roots.store.getRun(traceId)!.pinned).toBe(1);
    expect((await post(`/api/runs/${traceId}/pin`, { pinned: false })).status).toBe(200);
    expect(t!.roots.store.getRun(traceId)!.pinned).toBe(0);
    expect((await post(`/api/runs/${traceId}/pin`, {})).status).toBe(200); // no flag still pins
    expect(t!.roots.store.getRun(traceId)!.pinned).toBe(1);
  });

  it("refuses a string in place of a check's enabled flag, and still disables (#304)", async () => {
    const { post } = await serve();
    const id = "repeated-tool-call";
    const enabledOf = () => t!.roots.store.checkStats()[id]?.enabled;
    expect(enabledOf()).toBe(1); // the library check is registered and on

    expect((await post(`/api/checks/${id}/enabled`, { enabled: "false" })).status).toBe(400);
    expect(enabledOf()).toBe(1); // it did not read "false" as enabled, and did not flip it either

    expect((await post(`/api/checks/${id}/enabled`, { enabled: false })).status).toBe(200);
    expect(enabledOf()).toBe(0);
    expect((await post(`/api/checks/${id}/enabled`, { enabled: true })).status).toBe(200);
    expect(enabledOf()).toBe(1);
  });

  it("refuses a string in place of the chat permission flags, and keeps a real false (#316)", async () => {
    const { post } = await serve();
    expect(await refusal(await post("/api/chat/sessions", { agent: "codex", allow_edits: "false" }))).toBe("allow_edits must be true or false");
    expect(await refusal(await post("/api/chat/sessions", { agent: "codex", allow_commands: "true" }))).toBe("allow_commands must be true or false");

    const ok = await post("/api/chat/sessions", { agent: "codex", allow_edits: false, allow_commands: true });
    expect(ok.status).toBe(201);
    expect((await ok.json()) as unknown).toMatchObject({ allow_edits: false, allow_commands: true });
  });
});

describe("a string field must be a JSON string", () => {
  it("refuses a non-string chat cwd, title or trace_id by name (#437)", async () => {
    const { post } = await serve();
    expect(await refusal(await post("/api/chat/sessions", { agent: "codex", cwd: 5 }))).toBe("cwd must be a string");
    expect(await refusal(await post("/api/chat/sessions", { agent: "codex", cwd: "/tmp", title: 5 }))).toBe("title must be a string");
    expect(await refusal(await post("/api/chat/sessions", { agent: "codex", cwd: "/tmp", trace_id: 5 }))).toBe("trace_id must be a string");
  });

  it("refuses a non-string concern or workflow before it drafts anything (#438)", async () => {
    const { post } = await serve();
    expect(await refusal(await post("/api/checks/draft", { concern: 5 }))).toBe("concern must be a string");
    expect(await refusal(await post("/api/checks/draft", { concern: { a: 1 } }))).toBe("concern must be a string");
    expect(await refusal(await post("/api/checks/draft", { concern: true }))).toBe("concern must be a string");
    // A real string that is too short keeps the route's own message.
    expect(await refusal(await post("/api/checks/draft", { concern: "short" }))).toBe("describe the concern in a sentence");
    // The workflow was reaching the drafter as-is, which answered with a raw ZodError dump.
    expect(await refusal(await post("/api/checks/draft", { concern: "the agent refunds without checking", workflow: 5 }))).toBe("workflow must be a string");
    expect(await refusal(await post("/api/checks/draft", { concern: "the agent refunds without checking", project: {} }))).toBe("project must be a string");
  });

  it("refuses a non-string question instead of judging it (#423)", async () => {
    const { post } = await serve({ engine: true });
    const traceId = hex(16);
    const root = hex(8);
    t!.roots.ingest([batch([span({ traceId, spanId: root, name: "refund", kind: "workflow" })])]);
    await until(() => t!.roots.store.getRun(traceId));

    expect(await refusal(await post("/api/steer/check", { trace_id: traceId, question: 123 }))).toBe("question must be a string");
    expect(await refusal(await post("/api/steer/check", { trace_id: traceId, question: {} }))).toBe("question must be a string");
    expect(await refusal(await post("/api/steer/check", { trace_id: traceId, question: "   " }))).toBe("trace_id and question required");
    expect(await refusal(await post("/api/steer/check", { trace_id: traceId, question: "did it refund?", span_ids: [1] }))).toBe("span_ids must be an array of strings");
  });

  it("refuses non-string settings strings, and changes nothing (#421)", async () => {
    const { post, get } = await serve();
    for (const b of [{ llm_model: 123 }, { llm_base_url: 123 }, { classifier_url: 123 }, { project: 5 }, { redact_patterns: "secrets" }, { redact_patterns: [1] }]) {
      const before = JSON.stringify(t!.roots.config);
      expect((await post("/api/settings", b)).status, JSON.stringify(b)).toBe(400);
      expect(JSON.stringify(t!.roots.config), JSON.stringify(b)).toBe(before);
    }
    // The GET that used to answer 500 once a number was stored as the model still works.
    expect((await get("/api/llm")).status).toBe(200);
  });

  it("refuses non-string external-LLM fields, and a string is not a boolean (#419)", async () => {
    const { post } = await serve();
    expect(await refusal(await post("/api/llm/external", { model: 123 }))).toBe("model must be a string");
    expect(await refusal(await post("/api/llm/external", { base_url: 123 }))).toBe("base_url must be a string");
    expect(await refusal(await post("/api/llm/external", { provider: 123 }))).toBe("provider must be a string");
    expect(await refusal(await post("/api/llm/external", { enabled: "false" }))).toBe("enabled must be true or false");
    expect(await refusal(await post("/api/llm/external", { fallback_to_local: "false" }))).toBe("fallback_to_local must be true or false");
    expect(t!.roots.config.llm.external.enabled).toBeFalsy(); // "false" did not turn it on
  });
});

describe("the replay overrides are checked before they are stored", () => {
  it("refuses a non-string system, edit or message field (#425)", async () => {
    const { post } = await serve();
    const traceId = hex(16);
    const root = hex(8);
    t!.roots.ingest([batch([llmSpan(traceId, root, { system: "You are a refund agent.", user: "Refund order 4512" })])]);
    await until(() => t!.roots.store.getRun(traceId));
    const llmSpanId = t!.roots.store.db.prepare("SELECT span_id FROM spans WHERE trace_id = ? AND span_kind = 'LLM'").get(traceId) as { span_id: string };

    expect(await refusal(await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, system: 5 }))).toBe("system must be a string");
    expect(await refusal(await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, edit: { from: 5, to: "x" } }))).toBe("edit.from must be a string");
    expect(await refusal(await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, edit: { from: "x" } }))).toBe("edit.to must be a string");
    expect(await refusal(await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, messages: "hi" }))).toBe("messages must be an array");
    expect(await refusal(await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, messages: [{ role: "user", content: 5 }] }))).toBe("messages[0].content must be a string");
    expect(await refusal(await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, model: 5 }))).toBe("model must be a string");

    // Nothing was stored for a refused request, so the run still has no replays.
    expect(t!.roots.replays.forRun(traceId)).toEqual([]);
  });

  it("still accepts the overrides it always did", async () => {
    const { post } = await serve({ llm: true, engine: true });
    const traceId = hex(16);
    const root = hex(8);
    t!.roots.ingest([batch([llmSpan(traceId, root, { system: "You are a refund agent.", user: "Refund order 4512" })])]);
    await until(() => t!.roots.store.getRun(traceId));
    const llmSpanId = t!.roots.store.db.prepare("SELECT span_id FROM spans WHERE trace_id = ? AND span_kind = 'LLM'").get(traceId) as { span_id: string };

    // Messages replaced outright.
    const replaced = await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, messages: [{ role: "user", content: "Refund order 9" }], model: "mock-model" });
    expect(replaced.status).toBe(200);
    expect(((await replaced.json()) as { overrides: { messages: { content: string }[] } }).overrides.messages.at(-1)?.content).toBe("Refund order 9");

    // One recorded message edited in place, which is what `edit` is for.
    const edited = await post(`/api/runs/${traceId}/replay`, { span_id: llmSpanId.span_id, edit: { from: "Refund order 4512", to: "Refund order 9" } });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { overrides: { messages: { content: string }[] } }).overrides.messages.at(-1)?.content).toBe("Refund order 9");
  });
});
