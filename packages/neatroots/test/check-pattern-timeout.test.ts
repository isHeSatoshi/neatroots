import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { log } from "../src/util/log.js";

/**
 * The time limit on a check's pattern is wall clock, so on a loaded machine a pattern that normally
 * takes a fraction of a millisecond can be descheduled past it. These tests drive that first
 * timeout deliberately: `state.timeouts` is how many of the next calls report running out of time.
 */
const state = vi.hoisted(() => ({ timeouts: 0 }));

vi.mock("../src/util/regex.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/util/regex.js")>();
  return {
    ...actual,
    testWithin: (re: RegExp, s: string, ms: number) => {
      if (state.timeouts > 0) {
        state.timeouts--;
        return undefined;
      }
      return actual.testWithin(re, s, ms);
    },
  };
});

const { checkFiles } = await import("../src/checks/offline.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-pattern-timeout-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const kv = (key: string, v: string) => ({ key, value: { stringValue: v } });

/** A one-span trace whose span carries the name the rule matches on. */
function traceFile(name: string, spanName: string, traceId: string, spanId: string): string {
  const span = {
    traceId,
    spanId,
    name: spanName,
    kind: 1,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000010000000",
    attributes: [kv("neatroots.span.kind", "llm")],
    status: { code: 1 },
  };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "check-demo")] }, scopeSpans: [{ scope: { name: "t" }, spans: [span] }] }] }));
  return file;
}

/** A checks folder holding one match rule. */
function ruleDir(name: string, id: string, pattern: string): string {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.yaml`), `id: ${id}\nkind: rule\nrule: {type: match, field: name, pattern: '${pattern}'}\n`);
  return folder;
}

const evidence = (out: { runs: { findings: { evidence_span_ids: string[] }[] }[] }) => out.runs.map((r) => r.findings.flatMap((f) => f.evidence_span_ids));

describe("a check pattern that runs out of time", () => {
  it("still fires when only the first attempt runs out of time", () => {
    const file = traceFile("once.json", "bad", "1".repeat(32), "a".repeat(16));
    const dirs = [ruleDir("once", "slow-once", "^bad$")];
    state.timeouts = 1;
    // One wall-clock miss is the machine, not the pattern, so the check keeps working.
    expect(evidence(checkFiles([file], { dirs, only: ["slow-once"] }))).toEqual([["a".repeat(16)]]);
  });

  it("is skipped once it runs out of time twice in a row, and only that check", () => {
    const slow = traceFile("slow.json", "bad", "2".repeat(32), "b".repeat(16));
    const other = traceFile("other.json", "bad", "3".repeat(32), "c".repeat(16));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      state.timeouts = 2;
      // Both attempts miss: this is the pattern the limit exists for, so the check is dropped.
      expect(evidence(checkFiles([slow], { dirs: [ruleDir("slow", "slow-rule", "^bad$")], only: ["slow-rule"] }))).toEqual([[]]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("check slow-rule:");
      // A different check that happens to use the same pattern text is unaffected.
      expect(evidence(checkFiles([other], { dirs: [ruleDir("other", "other-rule", "^bad$")], only: ["other-rule"] }))).toEqual([["c".repeat(16)]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("is skipped when it is genuinely too slow, so the limit still protects the server", () => {
    // (a|aa)+ backtracks for minutes on this input; it cannot finish either attempt.
    const file = traceFile("slow-real.json", "a".repeat(40) + "b", "4".repeat(32), "d".repeat(16));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      state.timeouts = 0;
      expect(evidence(checkFiles([file], { dirs: [ruleDir("real", "really-slow", "^(a|aa)+$")], only: ["really-slow"] }))).toEqual([[]]);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("check really-slow:");
    } finally {
      warn.mockRestore();
    }
  });
});
