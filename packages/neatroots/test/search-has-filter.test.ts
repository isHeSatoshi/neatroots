import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots, span, toolSpan, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

// `has:` was the one filter where a value this build did not know made the search return every run
// instead of filtering: the route compared the value exactly (`filters.has === "problems"`), so
// `has:Problems` and `has:PROBLEMS` returned everything while the query still looked filtered.
// `since:` refuses an unreadable value now, and the words `has:` accepts are a fixed list, so this
// refuses too rather than answering a question nobody asked.
describe("the has: filter", () => {
  async function setup() {
    t = await makeRoots({ noEngine: true, serve: true });
    const clean = hex(16);
    const cleanRoot = span({ traceId: clean, name: "clean-agent", kind: "workflow" });
    t.roots.ingest([batch([cleanRoot, llmSpan(clean, cleanRoot.spanId, { user: "where is order 4512" })], "e2e")]);

    const flagged = hex(16);
    const flaggedRoot = span({ traceId: flagged, name: "flagged-agent", kind: "workflow" });
    t.roots.ingest([batch([flaggedRoot, toolSpan(flagged, flaggedRoot.spanId, "charge_card", "card 4242", undefined, "card declined")], "e2e")]);

    // A third run with no finding at all, so "runs with a finding" and "every run" are different
    // answers: without it, a dropped filter would look like a working one.
    const quiet = hex(16);
    const quietRoot = span({ traceId: quiet, name: "quiet-agent", kind: "workflow" });
    t.roots.ingest([batch([quietRoot, llmSpan(quiet, quietRoot.spanId, { user: "what is the weather" })], "e2e")]);

    // A resolved finding is not an open one, so the two words are distinguishable.
    t.roots.store.insertFinding({ trace_id: flagged, check_id: "c", check_kind: "rule", title: "F", probability: null, status: "resolved", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });
    t.roots.store.insertFinding({ trace_id: clean, check_id: "c", check_kind: "rule", title: "F", probability: null, status: "raised", evidence_span_ids: [], detail: {}, model: null, triage_score: null, explanation_id: null });

    const ids = async (q: string) => {
      const r = await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      const j = (await r.json()) as { total: number; runs: { trace_id: string }[] };
      // The page and the total have to agree, or the header contradicts the list.
      expect(j.total, `total for ${q}`).toBe(j.runs.length);
      return j.runs.map((x) => x.trace_id).sort();
    };
    const refused = async (q: string, quoted: string) => {
      const r = await fetch(`${t!.url}/api/search/runs?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(400);
      const j = (await r.json()) as { error: string };
      // The message has to say what the filter does take, and which value it could not read, or
      // the caller is left guessing. `quoted` is what the message should show for the value, which
      // for an empty one is a pair of quotes rather than nothing at all.
      expect(j.error, q).toMatch(/problems or finding/);
      expect(j.error, q).toContain(`not ${quoted}`);
    };
    const sorted = (...xs: string[]) => xs.sort();
    return { clean, flagged, quiet, ids, refused, sorted };
  }

  it("reads problems in any case", async () => {
    const { clean, ids, sorted } = await setup();
    // `clean` is the run with the open finding.
    for (const q of ["has:problems", "has:Problems", "has:PROBLEMS", "has:problem"]) {
      expect(await ids(q), q).toEqual(sorted(clean));
    }
  });

  it("reads finding as the rest of neatroots spells it", async () => {
    const { clean, flagged, ids, sorted } = await setup();
    for (const q of ["has:finding", "has:Finding", "has:findings", "has:FINDINGS"]) {
      expect(await ids(q), q).toEqual(sorted(clean, flagged));
    }
  });

  it("refuses a word it does not know instead of searching every run", async () => {
    // The bug: an unknown word left the filter off and returned everything, so a typo looked like
    // a working search. A refusal cannot be mistaken for a result.
    const { refused } = await setup();
    for (const q of ["has:nonsense", "has:Problems2", "has:issue"]) await refused(q, `"${q.slice(4)}"`);
    // An empty value is unreadable too, and it is the case a truthiness check would skip.
    await refused('has:""', '""');
  });

  it("leaves a bare has: to the text search, like every other filter word", async () => {
    // `has:` with nothing after it is not a filter at all, so it stays a word to find.
    const { ids } = await setup();
    expect(await ids("has:")).toEqual([]);
  });

  it("still combines with the other filters", async () => {
    const { clean, flagged, quiet, ids, sorted } = await setup();
    expect(await ids("has:problems clean-agent")).toEqual(sorted(clean));
    expect(await ids("has:problems flagged-agent")).toEqual([]);
    expect(await ids("has:problems project:none")).toEqual([]);
    // Without a `has:` word all three runs come back, so the filter above is doing the work.
    expect(await ids("agent")).toEqual(sorted(clean, flagged, quiet));
  });
});
