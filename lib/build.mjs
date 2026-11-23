// Bundles the extension into dist/. Usage: node lib/build.mjs [--test]
// --test builds into dist-test/, where the extension also opens its sidebar
// page in a tab when installed, since automation can't open extension pages itself.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const test = process.argv.includes("--test");
const dist = join(root, test ? "dist-test" : "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true, filter: (p) => !p.endsWith(".svg") });
await esbuild.build({
  bundle: true, format: "esm", target: "firefox140", minify: false, logLevel: "warning",
  outdir: dist, absWorkingDir: root,
  define: { __TEST__: String(test) },
  entryPoints: { sidebar: "src/sidebar.ts" },
});
// A persistent background page (Manifest V2): Firefox keeps it awake, so a slow local
// model call or a long scheduled run isn't cut off at 30 seconds, as an MV3 event page is.
await esbuild.build({
  bundle: true, format: "iife", target: "firefox140", minify: false, logLevel: "warning",
  outdir: dist, absWorkingDir: root, define: { __TEST__: String(test) },
  entryPoints: { background: "src/background.ts" },
});
console.log(`built ${dist}`);
