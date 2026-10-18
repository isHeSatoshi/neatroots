import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store, SCHEMA_VERSION } from "../src/store/db.js";
import { missingPayload } from "../src/store/blobs.js";
import { batch, closeTrackedStores, hex, makeRoots, s, span, tmpHome, trackedStore } from "./helpers.js";

// A store is a database plus a payload tree beside it. A copy that takes only the database keeps
// every reference and loses every payload, so what is missing has to be visible.

const homes: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
function store(): { st: Store; home: string } {
  const home = tmpHome();
  homes.push(home);
  return { st: trackedStore(path.join(home, "data")), home };
}
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
  closeTrackedStores();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

/** A run with one payload above the blob threshold. Returns its trace id and the payload's sha. */
function runWithPayload(st: Store, fill = "x"): { t: string; sha: string; big: string } {
  const t = hex(16);
  const root = hex(8);
  const big = fill.repeat(100_000);
  st.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.workflow.input", big)] })])]);
  const row = st.db.prepare("SELECT blobs FROM spans WHERE trace_id = ?").get(t) as { blobs: string | null };
  return { t, sha: JSON.parse(row.blobs!)[0] as string, big };
}

/** The run's payload attribute, whichever position it ended up in. */
function payloadAttr(st: Store, traceId: string): string {
  const span = st.getOtlpSpan(traceId, st.getRun(traceId)!.root_span_id!)!.span;
  return (span.attributes.find((a) => a.key === "neatlogs.workflow.input")!.value as { stringValue: string }).stringValue;
}

const blobFile = (home: string, sha: string) => path.join(home, "data", "blobs", sha.slice(0, 2), sha.slice(2));

describe("a payload that is not on disk", () => {
  it("reads back as a notice naming it, not as an empty string", () => {
    const { st, home } = store();
    const { t, sha, big } = runWithPayload(st);
    expect(payloadAttr(st, t)).toBe(big);

    fs.rmSync(blobFile(home, sha));
    // An empty string hid the loss on the run page, over the API, over MCP and in a forward.
    expect(payloadAttr(st, t)).not.toBe("");
    expect(payloadAttr(st, t)).toBe(missingPayload({ sha, len: big.length }));
    expect(payloadAttr(st, t)).toContain(sha);
    // The reference itself is still there, so the payload can be identified and restored.
    expect(st.verify().missing).toEqual([sha]);
  });

  it("is listed by verify, which also reports the rest of the store", () => {
    const { st, home } = store();
    const { sha } = runWithPayload(st);
    const clean = st.verify();
    expect(clean).toMatchObject({ quick_check: "ok", schema_version: String(SCHEMA_VERSION), referenced: 1, present: 1, missing: [], orphaned: [] });
    expect(clean.present_bytes).toBe(100_000);
    expect(clean.referenced_bytes).toBe(100_000);
    expect(clean.file).toContain("neatroots.db");

    fs.rmSync(blobFile(home, sha));
    const damaged = st.verify();
    expect(damaged).toMatchObject({ quick_check: "ok", referenced: 1, present: 0, missing: [sha], referenced_bytes: 0, present_bytes: 0 });
  });

  it("reports a payload file nothing references any more", () => {
    const { st, home } = store();
    runWithPayload(st);
    const stray = path.join(home, "data", "blobs", "ab", "orphan");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, "stray", "utf8");
    const r = st.verify();
    expect(r.missing).toEqual([]);
    expect(r.orphaned).toEqual(["ab" + "orphan"]);
    expect(r.referenced).toBe(1);
    expect(r.present).toBe(2);
  });

  it("scopes the lookup to the traces asked about", () => {
    const { st, home } = store();
    const { t: damaged, sha } = runWithPayload(st, "x");
    const { t: healthy } = runWithPayload(st, "y");
    fs.rmSync(blobFile(home, sha));
    expect(st.missingBlobs([damaged])).toEqual([sha]);
    expect(st.missingBlobs([healthy])).toEqual([]);
    expect(st.missingBlobs()).toEqual([sha]);
  });

  it("refuses to forward a run whose payloads are gone instead of sending placeholders", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    const sink = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close, sink.close);
    const t = hex(16);
    const root = hex(8);
    const big = "x".repeat(100_000);
    tb.roots.ingest([batch([span({ traceId: t, spanId: root, name: "refund", kind: "workflow", attrs: [s("neatlogs.workflow.input", big)] })])]);
    const sha = (JSON.parse((tb.roots.store.db.prepare("SELECT blobs FROM spans").get() as { blobs: string }).blobs) as string[])[0];

    // Whole store: it forwards, payload and all.
    const ok = await tb.roots.relay.forward([t], "test", { endpoint: sink.url, apiKey: "nl-test-key" });
    expect(ok.status).toBe("ok");
    const sent = sink.roots.store.batchesForTraces([t]).flatMap((b) => b.spans).find((x) => x.spanId === root)!;
    expect((sent.attributes.find((a) => a.key === "neatlogs.workflow.input")!.value as { stringValue: string }).stringValue).toBe(big);

    // Payload gone: refused, with the reason, and nothing sent.
    fs.rmSync(path.join(tb.roots.home, "data", "blobs", sha.slice(0, 2), sha.slice(2)));
    const refused = await tb.roots.relay.forward([t], "test", { endpoint: sink.url, apiKey: "nl-test-key" });
    expect(refused.status).toBe("error");
    expect(refused.error).toMatch(/payload file\(s\) this run references are missing/);
    expect(refused.error).toMatch(/store verify/);
    expect(refused.span_count).toBe(0);
  });
});

describe("the store says which schema it is", () => {
  it("records its own version and reads it back", () => {
    const { st } = store();
    expect(st.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("refuses a store written by a newer neatroots, with a readable message", () => {
    const { st, home } = store();
    st.setMeta("schema_version", String(SCHEMA_VERSION + 1));
    st.close();
    closeTrackedStores();
    expect(() => new Store(path.join(home, "data"))).toThrow(/newer neatroots/);
    expect(() => new Store(path.join(home, "data"))).toThrow(new RegExp(`schema ${SCHEMA_VERSION + 1}`));
  });

  it("refuses it before it migrates anything", () => {
    const { st, home } = store();
    // A store a newer build wrote: newer version, and a shape this build would otherwise repair.
    st.db.exec("ALTER TABLE plans DROP COLUMN body");
    st.setMeta("schema_version", String(SCHEMA_VERSION + 1));
    st.close();
    closeTrackedStores();
    const dir = path.join(home, "data");
    expect(() => new Store(dir)).toThrow(/newer neatroots/);

    const raw = new Database(Store.dbFile(dir), { readonly: true });
    const cols = (raw.prepare("PRAGMA table_info(plans)").all() as { name: string }[]).map((c) => c.name);
    raw.close();
    expect(cols).not.toContain("body"); // the refusal came before the migration, so nothing was added
  });
});

describe("a payload path that is not a readable file", () => {
  it("counts as missing, not as present", () => {
    const { st, home } = store();
    const { t, sha, big } = runWithPayload(st);
    fs.rmSync(blobFile(home, sha));
    fs.mkdirSync(blobFile(home, sha), { recursive: true });
    // The directory made the old presence check say the payload was there, while reads returned
    // undefined, so verify called the store whole and a forward would have sent the notice as content.
    const r = st.verify();
    expect(r.missing).toEqual([sha]);
    expect(r.present).toBe(0);
    expect(r.orphaned).toEqual([]);
    expect(payloadAttr(st, t)).toBe(missingPayload({ sha, len: big.length }));
  });
});

describe("store verify leaves the store it inspects alone", () => {
  it("reports a home with no database instead of creating one", () => {
    const home = tmpHome();
    homes.push(home);
    const dir = path.join(home, "data");
    expect(() => Store.verify(dir)).toThrow(/no store database/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a newer store before reading tables it may have renamed", () => {
    const { st, home } = store();
    runWithPayload(st);
    // A newer build could have renamed or dropped what the report reads; this stands in for that.
    st.db.exec("DROP TABLE spans");
    st.setMeta("schema_version", String(SCHEMA_VERSION + 1));
    st.close();
    closeTrackedStores();
    const dir = path.join(home, "data");

    // The refusal has to come first, or the report's own queries fail and the operator sees a raw
    // SQLite error instead of being told to update neatroots.
    expect(() => Store.verify(dir)).toThrow(new RegExp(`store schema ${SCHEMA_VERSION + 1}, this build reads ${SCHEMA_VERSION}`));
    expect(() => Store.verify(dir)).not.toThrow(/no such table/);
  });

  it("reads an older store without migrating it", () => {
    const { st, home } = store();
    const { t, big } = runWithPayload(st);
    st.db.exec("ALTER TABLE plans DROP COLUMN body"); // as a store from before that column looks
    st.close();
    closeTrackedStores();
    const dir = path.join(home, "data");

    const r = Store.verify(dir);
    expect(r).toMatchObject({ runs: 1, referenced: 1, present: 1, missing: [], quick_check: "ok" });

    const raw = new Database(Store.dbFile(dir), { readonly: true });
    const cols = (raw.prepare("PRAGMA table_info(plans)").all() as { name: string }[]).map((c) => c.name);
    raw.close();
    expect(cols).not.toContain("body"); // verify read the store; it did not migrate it

    const again = trackedStore(dir); // an ordinary open still migrates, so the check above means something
    expect(again.verify()).toMatchObject({ runs: 1, missing: [] });
    expect((again.db.prepare("PRAGMA table_info(plans)").all() as { name: string }[]).map((c) => c.name)).toContain("body");
    expect(payloadAttr(again, t)).toBe(big);
  });
});

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
function verifyCli(home: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "store", "verify", "--home", home], { cwd: pkgRoot, encoding: "utf8" });
}

describe("neatroots store verify", () => {
  it("says there is no store, and creates none, when a home has an empty data folder", () => {
    const home = tmpHome();
    homes.push(home);
    fs.mkdirSync(path.join(home, "data"), { recursive: true }); // a home that has not written a store yet
    const r = verifyCli(home);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No store at .*neatroots creates it on first run\./);
    expect(fs.readdirSync(path.join(home, "data"))).toEqual([]); // it did not create the store it was asked to check
  });

  it("prints both payload totals, and fails when a referenced payload is gone", () => {
    const { st, home } = store();
    const { sha } = runWithPayload(st);
    st.close();
    closeTrackedStores();
    const ok = verifyCli(home);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/payloads: 1 referenced \(0\.1 MB\), 1 on disk \(0\.1 MB\)/);
    expect(ok.stdout).toMatch(/✓ store reads whole/);

    fs.rmSync(blobFile(home, sha));
    const bad = verifyCli(home);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(new RegExp(`missing payload ${sha}`));
  });

  it("refuses a store written by a newer neatroots, the same as opening it does", () => {
    const { st, home } = store();
    st.setMeta("schema_version", String(SCHEMA_VERSION + 1));
    st.close();
    closeTrackedStores();
    const r = verifyCli(home);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`store schema ${SCHEMA_VERSION + 1}, this build reads ${SCHEMA_VERSION}`));
    expect(r.stdout).not.toMatch(/store reads whole/);
  });
});
