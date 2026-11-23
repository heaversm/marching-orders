// Gives the writer a sentence on a real public website and reports what it drafted
// and what the practice run found. Uses Claude and the key saved in .profile/ by
// `npm run try` (each draft is a paid call, two if it redrafts). Close the try
// window first. Usage:
//   node e2e/real.mjs <url> "<sentence>" [--local]
import { join } from "node:path";
import { launch, root, sidebarPage, until, sleep } from "../lib/firefox.mjs";
import { startRelay } from "../lib/relay.mjs";
import { spawn } from "node:child_process";

const [url, sentence] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const local = process.argv.includes("--local");
if (!url || !sentence) { console.log('Usage: node e2e/real.mjs <url> "<sentence>"'); process.exit(2); }
const busy = await fetch("http://localhost:8090/__sidebar").then(() => true, () => false);
if (busy) { console.log("The Marching Orders test window (npm run try) is still open. Quit that Firefox (⌘Q in it), then run this again."); process.exit(2); }
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]); // only for the sidebar trick
const relay = await startRelay().catch(() => null);
await sleep(400);
const { browser, ext } = await launch({ headless: true, ...(local ? {} : { profile: join(root, ".profile") }) });
try {
  const web = await browser.newPage();
  await web.setViewport({ width: 1280, height: 900 });
  await web.goto(url, { waitUntil: "load", timeout: 60_000 }).catch((e) => console.log("load:", e.message));
  await sleep(4000);
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  if (!local && !(await send({ type: "state" })).value.settings.apiKey) throw new Error("No API key in .profile");
  await send({ type: "settings", settings: local ? { writer: "local", ollamaUrl: "http://127.0.0.1:11435" } : { writer: "cloud" } });
  await web.bringToFront();
  await sleep(500);
  console.log("page:", (await send({ type: "page" })).value, "|", await web.title());
  await side.evaluate((t) => { document.querySelector("#sentence").value = t; }, sentence);
  const t0 = Date.now();
  const before = (await send({ type: "state" })).value.drafts.length;
  await side.click("#draft");
  const s = await until(async () => {
    const st = await side.$eval("#status", (e) => e.className + "|" + e.textContent);
    if (st.includes("error")) return { error: st };
    const v = (await send({ type: "state" })).value;
    return v.drafts.length > before ? v : null;
  }, 400_000, 1000);
  if (s.error) { console.log("ERROR", s.error); process.exitCode = 1; }
  else {
    const d = s.drafts.at(-1);
    const runs = s.log.filter((x) => x.orderId === d.id);
    const pr = runs.at(-1);
    console.log(`drafted in ${Math.round((Date.now() - t0) / 1000)} s; practice runs: ${runs.length}`);
    console.log(JSON.stringify({ can_do: d.can_do, cannot_reason: d.cannot_reason, title: d.title, summary: d.summary, trigger: d.trigger, sites: d.sites, model: d.model }, null, 1));
    console.log("steps:", JSON.stringify(d.steps, null, 1));
    if (pr) console.log("practice:", JSON.stringify({ ok: pr.ok, error: pr.error, found: pr.found, kept: pr.kept, told: pr.told.slice(0, 8), warnings: pr.warnings, steps: pr.steps, firstItems: pr.items?.slice(0, 3) }, null, 1));
    await send({ type: "discard", id: d.id });
  }
} finally { await browser.close(); site.kill(); relay?.close(); }
