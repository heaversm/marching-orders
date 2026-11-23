// Captures screenshots of the real extension for the walkthrough video and about page.
// Orders are imported (the ones Claude wrote on Nov 20), so no paid calls; the repair
// shot uses a local Ollama on 11435. Writes to shots/ (or SHOTS_DIR).
// Usage: node e2e/capture.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { launch, root, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";

const OUT = process.env.SHOTS_DIR ?? join(root, "shots");
mkdirSync(OUT, { recursive: true });
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
const admin = (p) => fetch(`http://localhost:8090${p}`).then((r) => r.text());
await admin("/admin/reset");

const file = (sentence, draft) => ({ format: "marching-orders/1", sentence, sharedAt: "", draft: { can_do: true, cannot_reason: "", ...draft } });
const GF = (a, b) => `https://www.google.com/travel/flights?q=Flights%20from%20PDX%20to%20MTJ%20on%20{today+${a}}%20returning%20{today+${b}}%20round%20trip%201%20adult&hl=en&gl=us&curr=USD`;
// As Claude wrote it on Nov 20 (e2e/real.mjs run), with the five extra searches 5 days apart.
const FLIGHTS = file("Every 2 weeks, check prices for round trips over roughly the next month and tell me about any 3 to 5 day trip under $400", {
  title: "Cheap Portland–Montrose round trips",
  summary: "Every two weeks this opens your Portland to Montrose search at six starting dates, reads each date grid of round-trip prices, and tells you about any new 3 to 5 day trips under $400.",
  trigger: { kind: "every", minutes: 20160 }, sites: ["https://www.google.com"], model: "none",
  steps: [
    { do: "open", url: GF(10, 14) },
    { do: "click", label: "Date grid" },
    { do: "collect", items: '[aria-label*="$"][aria-label*=" to "]', key: "label", fields: [{ name: "label", selector: "", attribute: "aria-label" }] },
    { do: "read_also", urls: [[15, 19], [20, 24], [25, 29], [30, 34], [35, 39]].map(([a, b]) => GF(a, b)) },
    { do: "compute", name: "price", from: ["label"], how: "number" },
    { do: "compute", name: "trip_days", from: ["label"], how: "days_between" },
    { do: "compute", name: "trip", from: ["label"], how: "dates" },
    { do: "keep", field: "price", test: "less_than", value: "400" },
    { do: "keep", field: "trip_days", test: "between", value: "3..5" },
    { do: "only_new", field: "trip" },
    { do: "notify", title: "{count} PDX–MTJ trips under $400", line: "{trip} ({trip_days} days) — ${price}", only_if: [] },
  ],
});
const WATCH = file("Tell me when a 2-bed under $2,800 shows up on this page", {
  title: "Cheap 2-beds on Maple Rentals", summary: "Checks Maple Rentals every 30 minutes for new 2-bed apartments under $2,800.",
  trigger: { kind: "every", minutes: 30 }, sites: [SITE], model: "none",
  steps: [
    { do: "open", url: `${SITE}/listings` },
    { do: "collect", items: "article.listing", key: "link", fields: [{ name: "title", selector: "h2.title", attribute: "text" }, { name: "price", selector: ".price", attribute: "text" }, { name: "beds", selector: ".beds", attribute: "text" }, { name: "link", selector: "h2.title a", attribute: "href" }] },
    { do: "keep", field: "beds", test: "contains", value: "2" },
    { do: "keep", field: "price", test: "less_than", value: "2800" },
    { do: "only_new" },
    { do: "notify", title: "New 2-beds under $2,800", line: "{title} — {price}", only_if: [] },
  ],
});

const { browser, ext } = await launch({ headless: true });
const shot = async (page, name, clip) => { await page.screenshot({ path: join(OUT, `${name}.png`), ...(clip ? { clip } : { fullPage: false }) }); console.log("shot", name); };
const { writeFileSync } = await import("node:fs");
// The sidebar can't be resized under automation, so save its real state and draw it later (e2e/render-shots.mjs).
const saveState = async (send, name, extra = {}) => { const st = (await send({ type: "state" })).value; writeFileSync(join(OUT, `state-${name}.json`), JSON.stringify({ ...st, ...extra }, null, 1)); console.log("state", name); };
try {
  const web = await browser.newPage();
  await web.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  await send({ type: "settings", settings: { writer: "local", ollamaUrl: "http://127.0.0.1:11435" } });
  const grant = async (origins) => {
    await side.evaluate((o) => { const b = document.createElement("button"); b.id = "grant"; b.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px;opacity:0"; b.onclick = () => browser.permissions.request({ origins: o }); document.body.append(b); }, origins);
    await side.click("#grant"); await sleep(300);
    await side.evaluate(() => document.getElementById("grant")?.remove());
  };
  await grant(["https://www.google.com/*", "http://maple-rentals.test/*"]);

  // 1. Google Flights with the sentence typed in the sidebar.
  await web.goto("https://www.google.com/travel/flights?q=Flights%20from%20PDX%20to%20MTJ%20on%202026-12-10%20returning%202026-12-14%20round%20trip%201%20adult&hl=en&gl=us&curr=USD", { waitUntil: "load", timeout: 60000 });
  await sleep(4000);
  await shot(web, "flights-page");
  await side.evaluate((t) => { document.querySelector("#sentence").value = t; }, FLIGHTS.sentence);
  await saveState(send, "compose", { page: "https://www.google.com/travel/flights", sentence: FLIGHTS.sentence });

  // 2. The draft card with its practice run (real Google, no AI).
  await side.evaluate(() => { document.querySelector("#sentence").value = ""; });
  const d = (await send({ type: "import", file: FLIGHTS })).value;
  await send({ type: "practice", id: d.id });
  await sleep(800);
  await saveState(send, "draft", { page: "https://www.google.com/travel/flights", status: "Here's the draft. Nothing runs until you approve it." });

  // 3. Approved: the order card, Matches now.
  await send({ type: "approve", id: d.id });
  const firstRun = await until(async () => (await send({ type: "state" })).value.log.find((x) => x.orderId === d.id && x.why === "schedule"), 400_000, 3000).catch(async (e) => { console.log("no first run:", JSON.stringify((await send({ type: "state" })).value.log.at(-1)).slice(0, 600)); throw e; });
  console.log("first run:", firstRun.ok, firstRun.error, firstRun.found, firstRun.told.length, Math.round(firstRun.ms / 1000) + " s");
  await sleep(800);
  await saveState(send, "order", { page: "https://www.google.com/travel/flights", status: "Approved. It runs on its own from now on." });

  // 4. A watcher on the rentals test site, then a redesign and a repair (local model).
  const w = (await send({ type: "import", file: WATCH })).value;
  await send({ type: "approve", id: w.id });
  await until(async () => (await send({ type: "state" })).value.log.some((x) => x.orderId === w.id && x.why === "schedule"));
  // A fresh tab: the Google Flights tab can hold up navigation.
  const web2 = await browser.newPage();
  await web2.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await web2.goto(`${SITE}/listings`, { waitUntil: "domcontentloaded" }); await sleep(1500);
  await shot(web2, "rentals-before");
  await admin("/admin/redesign?on=1");
  await web2.goto(`${SITE}/listings`, { waitUntil: "domcontentloaded" }); await sleep(1500);
  await shot(web2, "rentals-after");
  const rr = (await send({ type: "run", id: w.id })).value;
  console.log("repair run:", rr.repaired, rr.found, rr.steps.map((x) => x.note));
  await admin("/admin/add?title=Bright%202-bed%20by%20the%20river&price=2500&beds=2");
  await send({ type: "run", id: w.id });
  await admin("/admin/redesign?on=0");
  await sleep(800);
  await saveState(send, "repaired", { page: `${SITE}/listings`, collapsed: [d.id], open: [w.id] });

  // 5. Private page: the fake bank page, and what the writer is sent.
  await web2.goto(`${SITE}/bank/activity/4417`, { waitUntil: "domcontentloaded" }); await sleep(800);
  await shot(web2, "bank-page");
  const { outputFiles } = await esbuild.build({ entryPoints: ["src/page.ts"], bundle: true, format: "iife", globalName: "MO", write: false });
  await web2.evaluate(outputFiles[0].text);
  const masked = await web2.evaluate(() => globalThis.MO.outlinePage(6000, true));
  const plain = await web2.evaluate(() => globalThis.MO.outlinePage(6000, false));
  writeFileSync(join(OUT, "bank-outline-masked.txt"), masked);
  writeFileSync(join(OUT, "bank-outline-plain.txt"), plain);
  console.log("outlines written");

  // 6. The folded list.
  const all = (await send({ type: "state" })).value.orders.map((o) => o.id);
  await saveState(send, "folded", { page: "", collapsed: all });
} finally { await browser.close(); site.kill(); }
