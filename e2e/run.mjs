// End-to-end checks in a real (separate, downloaded) Firefox against the test
// sites. Model steps use a local Ollama; set OLLAMA_URL if it isn't on 11435.
// The writer test with Claude runs only with --cloud (it costs money).
// Usage: node e2e/run.mjs [--headless] [--skip-slow] [--cloud]
import { spawn } from "node:child_process";
import { launch, sidebarPage, until, sleep, SITE, NEWS } from "../lib/firefox.mjs";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11435";
const slow = !process.argv.includes("--skip-slow");
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
const admin = (path) => fetch(`http://localhost:8090${path}`).then((r) => r.text());

let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? `\n     ${extra}` : ""}`); if (!ok) failed++; };

const order = (draft, sentence) => ({ format: "marching-orders/1", sentence, draft, sharedAt: new Date().toISOString(), from: "the test suite" });
const WATCH = order({
  can_do: true, cannot_reason: "", title: "Cheap 2-beds on Maple Rentals",
  summary: "Checks Maple Rentals every 30 minutes and tells you about new 2-bed apartments under $2,800.",
  trigger: { kind: "every", minutes: 30 }, sites: [SITE], model: "none",
  steps: [
    { do: "open", url: `${SITE}/listings` },
    { do: "collect", items: "article.listing", key: "link", fields: [
      { name: "title", selector: "h2.title", attribute: "text" },
      { name: "price", selector: ".price", attribute: "text" },
      { name: "beds", selector: ".beds", attribute: "text" },
      { name: "link", selector: "h2.title a", attribute: "href" },
    ] },
    { do: "keep", field: "beds", test: "contains", value: "2" },
    { do: "keep", field: "price", test: "less_than", value: "2800" },
    { do: "only_new" },
    { do: "notify", title: "New 2-beds under $2,800", line: "{title} — {price}" },
  ],
}, "Tell me when a 2-bed under $2,800 shows up on Maple Rentals");

const { browser, ext } = await launch({ headless: process.argv.includes("--headless") });
try {
  await admin("/admin/reset");
  const web = await browser.newPage();
  await web.goto(`${SITE}/listings`);
  const side = await sidebarPage(browser, ext);
  const send = async (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  const state = async () => (await send({ type: "state" })).value;
  const text = (sel) => side.$eval(sel, (e) => e.textContent);
  await send({ type: "settings", settings: { writer: "local", ollamaUrl: OLLAMA } });

  // ---- sharing in: import a file ----
  const imp = await send({ type: "import", file: WATCH });
  check(imp.ok, "an order file imports as a draft", imp.error);
  let s = await state();
  check(s.drafts.length === 1 && s.drafts[0].from === "the test suite", "the draft says who it came from");
  const bad = await send({ type: "import", file: { format: "something-else" } });
  check(!bad.ok && /isn't a Marching Orders file/.test(bad.error), "a file that isn't an order is refused", bad.error);
  await side.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const card = await text("#drafts");
  check(/May touch\s*maple-rentals\.test:8090/.test(card), "the draft card shows the one site it may touch", card.slice(0, 300));
  check(/Sends data\s*Nowhere/.test(card), "the draft card says it sends data nowhere");

  // ---- practice, through the real button (Firefox grants the site: prompts are off in tests) ----
  await side.click("#drafts button[data-act=practice]");
  s = await until(async () => { const v = await state(); return v.log.some((r) => r.why === "practice") ? v : null; });
  let p = s.log.at(-1);
  // Two match on beds and price: the real one and a $1,200 scam. Rules alone can't tell them apart (see the judge test).
  check(p.ok && p.told.length === 2 && p.told.some((t) => /Sunny 2-bed/.test(t)) && p.told.some((t) => /WIRE/.test(t)), "practice run finds both 2-beds under $2,800, scam included", JSON.stringify(p.told));
  check(p.modelCalls.local + p.modelCalls.cloud === 0, "the practice run used no AI");

  // ---- approve ----
  await side.click("#drafts button[data-act=approve]");
  s = await until(async () => { const v = await state(); return v.orders.length === 1 && v.drafts.length === 0 ? v : null; });
  const id = s.orders[0].id;
  check(s.drafts.length === 0 && s.orders[0].approved, "approving moves it to your orders");
  const granted = await side.evaluate(() => browser.permissions.contains({ origins: ["http://maple-rentals.test/*"] }));
  check(granted, "Firefox granted exactly the order's site");
  const otherSite = await side.evaluate(() => browser.permissions.contains({ origins: ["http://daily-ledger.test/*"] }));
  check(!otherSite, "and not other sites");
  const alarms = await side.evaluate(() => browser.alarms.getAll());
  check(alarms.some((a) => a.name === `order:${id}` && a.periodInMinutes === 30), "a 30-minute timer is set");

  // ---- runs ----
  // Approving a timed order runs its first check right away.
  let r = await until(async () => (await state()).log.find((x) => x.orderId === id && x.why === "schedule"));
  check(r.ok && r.told.length === 2, "the first check, right after approval, tells you about both", JSON.stringify(r));
  const tabsAfter = await side.evaluate(async () => (await browser.tabs.query({})).filter((t) => t.hidden).length);
  check(tabsAfter === 0, "the hidden tab is closed after the run");
  r = (await send({ type: "run", id })).value;
  check(r.ok && r.found === 6 && r.told.length === 0, "second run: nothing new, nothing told", JSON.stringify(r.steps));
  await admin("/admin/add?title=Bright%202-bed%20by%20the%20river&price=2500&beds=2");
  await admin("/admin/add?title=Pricey%202-bed%20penthouse&price=4200&beds=2");
  r = (await send({ type: "run", id })).value;
  check(r.told.length === 1 && /Bright 2-bed/.test(r.told[0]), "a new matching listing is reported, the pricey one isn't", JSON.stringify(r.told));

  // ---- the site changes: repair ----
  await admin("/admin/redesign?on=1");
  const t0 = Date.now();
  r = (await send({ type: "run", id })).value;
  const o = (await state()).orders.find((x) => x.id === id);
  check(r.repaired && r.found >= 6, `after a redesign, the local model repairs the read step (${Math.round((Date.now() - t0) / 1000)} s)`, JSON.stringify(r.steps));
  check(o.version === 2 && o.repairs === 1, "the order records the repair and bumps its version");
  check(r.told.length === 0, "a repair doesn't re-report old listings", JSON.stringify(r.told));
  check(r.modelCalls.local === 1, "the repair was the only AI call");
  r = (await send({ type: "run", id })).value;
  check(r.ok && !r.repaired && r.modelCalls.local === 0, "the run after a repair needs no AI");
  await admin("/admin/redesign?on=0");

  // ---- the slip ----
  const sneaky = order({ ...WATCH.draft, title: "Sneaky", steps: [{ do: "open", url: `${NEWS}/news` }, ...WATCH.draft.steps.slice(1)] }, "sneaky");
  await send({ type: "import", file: sneaky });
  s = await state();
  r = (await send({ type: "practice", id: s.drafts.at(-1).id })).value;
  check(!r.ok && /isn't one of this order's sites/.test(r.error), "an order can't open a site it didn't list", r.error);
  const ungranted = order({ ...WATCH.draft, title: "Ungranted", sites: [NEWS], steps: [{ do: "open", url: `${NEWS}/news` }] }, "ungranted");
  await send({ type: "import", file: ungranted });
  s = await state();
  r = (await send({ type: "practice", id: s.drafts.at(-1).id })).value;
  check(!r.ok && /hasn't granted/.test(r.error), "an order can't open a listed site Firefox hasn't granted", r.error);
  for (const d of (await state()).drafts) await send({ type: "discard", id: d.id });

  // ---- reshaping a page on visit ----
  const hide = order({
    can_do: true, cannot_reason: "", title: "Hide sponsored stories", summary: "Hides sponsored stories on The Daily Ledger.",
    trigger: { kind: "on_visit", match: `${NEWS}/news` }, sites: [NEWS], model: "none",
    steps: [{ do: "hide", selector: "li.sponsored" }],
  }, "Hide sponsored stories on the Daily Ledger");
  await send({ type: "import", file: hide });
  s = await state();
  await side.click("#drafts button[data-act=approve]"); // grants daily-ledger.test
  await until(async () => (await state()).orders.length === 2);
  await web.goto(`${NEWS}/news`);
  const hidden = await until(() => web.evaluate(() => {
    const sp = [...document.querySelectorAll("li.sponsored")];
    return sp.length && sp.every((e) => getComputedStyle(e).display === "none") ? sp.length : 0;
  }), 15_000);
  check(hidden === 2, "visiting the news page hides both sponsored stories");
  const shown = await web.evaluate(() => [...document.querySelectorAll("li.story:not(.sponsored)")].every((e) => getComputedStyle(e).display !== "none"));
  check(shown, "and leaves the real stories alone");

  // ---- judge: the AI step that runs every time ----
  if (slow) {
    const scam = order({
      ...WATCH.draft, title: "2-beds, no scams", model: "local",
      steps: [...WATCH.draft.steps.slice(0, 4), { do: "judge", question: "Does this listing look like a legitimate rental, not a scam?" }, { do: "notify", title: "2-beds", line: "{title}" }],
    }, "Cheap 2-beds, skip anything that looks like a scam");
    await send({ type: "import", file: scam });
    s = await state();
    r = (await send({ type: "practice", id: s.drafts.at(-1).id })).value;
    check(r.ok && r.modelCalls.local >= 2, `judge asks the local model about each match (${r.modelCalls.local} calls)`, JSON.stringify(r));
    check(r.told.some((t) => /Sunny/.test(t)) && !r.told.some((t) => /WIRE/.test(t)), "and drops the scam listing", JSON.stringify(r.told));
    await send({ type: "discard", id: s.drafts.at(-1).id });
  }

  // ---- writing an order from a sentence (local model) ----
  if (slow) {
    await admin("/admin/reset");
    await web.goto(`${SITE}/listings`);
    await web.bringToFront(); // the page the person is looking at
    await sleep(500);
    await side.evaluate(() => { document.querySelector("#sentence").value = "Let me know when a studio shows up here"; });
    const t1 = Date.now();
    await side.click("#draft");
    s = await until(async () => {
      const v = await state();
      const st = await side.$eval("#status", (e) => e.className + "|" + e.textContent);
      if (st.includes("error")) return { error: st };
      return v.drafts.length ? v : null;
    }, 400_000, 1000);
    check(!s.error, `the local model drafts an order from a sentence (${Math.round((Date.now() - t1) / 1000)} s)`, s.error);
    if (!s.error) {
      const d = s.drafts.at(-1);
      const pr = s.log.filter((x) => x.orderId === d.id).at(-1);
      check(d.trigger.kind === "every" && d.steps.some((x) => x.do === "only_new"), "it chose a timer and only-new", JSON.stringify(d.steps.map((x) => x.do)));
      check(pr?.ok && pr.items?.length === 1 && /Studio/.test(Object.values(pr.items[0]).join(" ")) && /Old Town|1,700/.test(Object.values(pr.items[0]).join(" ")), "its practice run picks the one studio", JSON.stringify({ told: pr?.told, steps: d.steps.filter((x) => x.do !== "open") }));
      await send({ type: "discard", id: d.id });
    }
  }

  // ---- sharing out ----
  const file = (await send({ type: "share", id })).value;
  check(file.format === "marching-orders/1" && !("id" in file.draft) && file.draft.steps.length === 6, "share makes a file with the steps (the repaired version) and no personal state");
  const round = await send({ type: "import", file });
  check(round.ok, "and that file imports again");
  for (const d of (await state()).drafts) await send({ type: "discard", id: d.id });

  // ---- pause / cancel / study export ----
  await send({ type: "pause", id, paused: true });
  check(!(await side.evaluate(() => browser.alarms.getAll())).some((a) => a.name === `order:${id}`), "pausing removes the timer");
  await send({ type: "pause", id, paused: false });
  const study = (await send({ type: "export-study" })).value;
  check(study.orders.length === 2 && study.runs.length > 5 && study.events.some((e) => e.kind === "repaired"), "the study export has orders, runs and the repair");
  check(!JSON.stringify(study.runs).includes("Sunny 2-bed"), "the study export leaves out what orders found");

  // ---- the timer fires on its own ----
  if (slow) {
    const quick = order({ ...WATCH.draft, title: "Every minute", trigger: { kind: "every", minutes: 1 } }, "every minute");
    await send({ type: "import", file: quick });
    s = await state();
    await send({ type: "approve", id: s.drafts.at(-1).id });
    const qid = (await state()).orders.find((x) => x.title === "Every minute").id;
    console.log("     (waiting about a minute for the timer)");
    const fired = await until(async () => (await state()).log.some((x) => x.orderId === qid && x.why === "schedule"), 100_000, 2000).catch(() => false);
    check(fired, "a 1-minute order runs by itself");
    await send({ type: "cancel", id: qid });
  }
  await send({ type: "cancel", id });
  check(!(await state()).orders.some((x) => x.id === id), "cancelling removes the order");

  await side.screenshot({ path: "/tmp/marching-orders-sidebar.png" }).catch((e) => console.log("     (no screenshot:", e.message.slice(0, 80), ")"));
} catch (e) {
  console.log("FAIL crashed:", e.stack);
  failed++;
} finally {
  await browser.close();
  site.kill();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
