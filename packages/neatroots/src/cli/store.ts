import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { rootsHome } from "../config.js";
import { Store, type StoreVerify } from "../store/db.js";

// neatroots store: what is on disk. The store is a database plus a tree of payload files beside
// it, and a copy that takes only the database loses every large prompt and output.

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function registerStoreCommands(program: Command): void {
  const store = program.command("store").description("The local store on disk: neatroots.db plus its payload files");

  store
    .command("verify")
    .description("Check the store is readable and whole: SQLite integrity, and every payload a span references")
    .option("--home <dir>", "neatroots home to check (default: the one this machine uses)")
    .action(async (opts: { home?: string }) => {
      const dir = path.join(opts.home ?? rootsHome(), "data");
      const file = Store.dbFile(dir);
      // A verify reports on a store; it does not make one. Creating the database here would report a
      // store this machine never wrote as whole, and opening one for writing can migrate it.
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        console.log(`No store at ${dir}. neatroots creates it on first run.`);
        return;
      }
      let r: StoreVerify;
      try {
        r = Store.verify(dir);
      } catch (err) {
        console.log(`✗ ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${r.file}`);
      console.log(`  schema ${r.schema_version ?? "unknown"} · ${r.runs} runs · ${r.spans} spans`);
      console.log(`  sqlite integrity: ${r.quick_check}`);
      console.log(`  payloads: ${r.referenced} referenced (${mb(r.referenced_bytes)}), ${r.present} on disk (${mb(r.present_bytes)})`);
      for (const sha of r.missing) console.log(`  ✗ missing payload ${sha}`);
      for (const sha of r.orphaned) console.log(`  ! payload nothing references: ${sha}`);
      const clean = r.quick_check === "ok" && !r.missing.length;
      console.log(
        clean
          ? `✓ store reads whole${r.orphaned.length ? ` (${r.orphaned.length} unreferenced file(s), harmless)` : ""}`
          : `✗ ${r.missing.length} referenced payload(s) are gone: runs that used them show a missing-payload notice instead of their prompt or output, and forwarding refuses them`,
      );
      if (!clean) process.exitCode = 1;
    });
}
