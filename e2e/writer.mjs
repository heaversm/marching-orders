// Writer quality: give the same sentences to the writer several times and see
// whether the practice run gets the right answer. Usage:
//   node e2e/writer.mjs [--cloud] [--tries=3]
// --cloud uses Claude and the key saved in .profile/ by `npm run try` (costs money:
// one call per draft, two if it redrafts). Close the `npm run try` window first.
// Default: local model, fresh profile.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { launch, root, sidebarPage, until, sleep, SITE, NEWS } from "../lib/firefox.mjs";
import { startRelay } from "../lib/relay.mjs";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11435";
const tries = Number(process.argv.find((a) => a.startsWith("--tries="))?.split("=")[1] ?? 3);
// Graded on which listings were picked (the practice run's items), and separately on
// whether the notification text came out whole.
const has = (items, re) => items.some((it) => re.test(Object.values(it).join(" ")));
const CASES = [
  { url: `${SITE}/listings`, sentence: "Tell me when a 2-bed under $2,800 shows up here", want: (items) => items.length === 2 && has(items, /Sunny 2-bed|2,650/) && has(items, /WIRE DEPOSIT|1,200/) },
  { url: `${SITE}/listings`, sentence: "Let me know when a studio shows up here", want: (items) => items.length === 1 && has(items, /Studio/) && has(items, /Old Town|1,700/) },
  { url: `${SITE}/listings`, sentence: "Ping me about any Elm Park apartment on this site", want: (items) => items.length === 2 && has(items, /Sunny|2,650/) && has(items, /Quiet 1-bed|2,200/) },
];
// The try-it window holds the profile (and port 8090) while it's open.
const busy = await fetch("http://localhost:8090/__sidebar").then(() => true, () => false);
if (busy) { console.log("The Marching Orders test window (npm run try) is still open. Quit that Firefox (⌘Q in it), then run this again."); process.exit(2); }
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
await fetch("http://localhost:8090/admin/reset");
const cloud = process.argv.includes("--cloud");
const relay = cloud ? await startRelay().catch(() => null) : null;
const { browser, ext } = await launch({ headless: true, ...(cloud ? { profile: join(root, ".profile") } : {}) });
const results = [];
try {
  const web = await browser.newPage();
  await web.goto(`${SITE}/listings`);
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  await send({ type: "settings", settings: cloud ? { writer: "cloud" } : { writer: "local", ollamaUrl: OLLAMA } });
  if (cloud && !(await send({ type: "state" })).value.settings.apiKey) throw new Error("No API key saved in .profile — add one with npm run try first.");
  for (const c of CASES) for (let i = 0; i < tries; i++) {
    await web.goto(c.url); await web.bringToFront(); await sleep(300);
    await side.evaluate((t) => { document.querySelector("#sentence").value = t; document.querySelector("#status").textContent = ""; }, c.sentence);
    const before = (await send({ type: "state" })).value.drafts.length;
    const t0 = Date.now();
    await side.click("#draft");
    const s = await until(async () => {
      const st = await side.$eval("#status", (e) => e.className + "|" + e.textContent);
      if (st.includes("error")) return { error: st };
      const v = (await send({ type: "state" })).value;
      return v.drafts.length > before ? v : null;
    }, 400_000, 1000);
    if (s.error) { results.push({ sentence: c.sentence, ok: false, why: s.error }); console.log("FAIL", c.sentence, s.error); continue; }
    const d = s.drafts.at(-1);
    const pr = s.log.filter((x) => x.orderId === d.id).at(-1);
    const ok = !!pr?.ok && c.want(pr.items ?? []);
    const whole = !!pr && pr.told.length > 0 && !(pr.warnings ?? []).length && pr.told.every((t) => !/\$\$|—\s*$|:\s*$/.test(t));
    const redrafted = s.log.filter((x) => x.orderId === d.id).length > 1;
    results.push({ sentence: c.sentence, ok, whole, redrafted, s: Math.round((Date.now() - t0) / 1000) });
    console.log(ok ? "ok  " : "FAIL", `${c.sentence} (${Math.round((Date.now() - t0) / 1000)} s${redrafted ? ", second draft" : ""})`, `text ${whole ? "whole" : "has gaps"}: ${JSON.stringify(pr?.told?.[0] ?? "")}`, ok ? "" : JSON.stringify({ items: pr?.items?.length, warnings: pr?.warnings, steps: d.steps.filter((x) => x.do !== "open" && x.do !== "notify") }));
    await send({ type: "discard", id: d.id });
  }
} finally { await browser.close(); site.kill(); relay?.close(); }
const n = results.filter((r) => r.ok).length;
console.log(`\n${n} of ${results.length} drafts picked the right items; ${results.filter((r) => r.whole).length} had whole notification text; ${results.filter((r) => r.redrafted).length} needed a second draft`);
