// Checks for the steps added for real-world orders, no model needed:
// percent off and "or" filters (a shoe shop), times of day and totals (an hourly
// forecast), the daily 7am schedule, and spotting login and bot-check pages.
// Usage: node e2e/features.mjs [--headless]
import { spawn } from "node:child_process";
import { launch, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";

const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? `\n     ${extra}` : ""}`); if (!ok) failed++; };
const file = (draft) => ({ format: "marching-orders/1", sentence: draft.title, sharedAt: "", draft: { can_do: true, cannot_reason: "", summary: draft.title, sites: [SITE], model: "none", trigger: { kind: "manual" }, ...draft } });

const SHOES = file({
  title: "Climbing shoes deal",
  trigger: { kind: "every", minutes: 10080 },
  steps: [
    { do: "open", url: `${SITE}/shoes` },
    { do: "collect", items: "li.product-card", key: "link", fields: [
      { name: "name", selector: ".product-name", attribute: "text" },
      { name: "size", selector: ".size", attribute: "text" },
      { name: "now", selector: ".price-now", attribute: "text" },
      { name: "was", selector: ".price-was", attribute: "text" },
      { name: "link", selector: "a.product-link", attribute: "href" },
    ] },
    { do: "compute", name: "size_num", from: ["size"], how: "number" },
    { do: "keep", field: "size_num", test: "between", value: "9.5..10.5" },
    { do: "compute", name: "off", from: ["now", "was"], how: "percent_off" },
    { do: "keep_any", tests: [{ field: "now", test: "less_than", value: "105" }, { field: "off", test: "at_least", value: "25" }] },
    { do: "only_new" },
    { do: "notify", title: "{count} climbing shoe deals", line: "{name} ({size}) {now} — {off}% off", only_if: [] },
  ],
});
// Rain: tell me if the day's total is over 0.1 in, or any rain 7–10am or 3:30–6pm.
const RAIN = (kind) => file({
  title: "Rain check",
  trigger: { kind: "daily", at: "07:00" },
  steps: [
    { do: "open", url: `${SITE}/hourly?rain=${kind}` },
    { do: "collect", items: "tr.hour", key: "time", fields: [
      { name: "time", selector: ".time", attribute: "text" },
      { name: "temp", selector: ".temp", attribute: "text" },
      { name: "rain_in", selector: ".amount", attribute: "text" },
    ] },
    { do: "compute", name: "hour", from: ["time"], how: "time_of_day" },
    { do: "keep", field: "rain_in", test: "more_than", value: "0" },
    { do: "notify", title: "Rain today: {sum:rain_in} in", line: "{time}: {rain_in}", only_if: [
      { measure: "sum", field: "rain_in", where: [], test: "more_than", value: "0.1" },
      { measure: "count", field: "", where: [{ field: "hour", test: "between", value: "7..10" }], test: "at_least", value: "1" },
      { measure: "count", field: "", where: [{ field: "hour", test: "between", value: "15.5..18" }], test: "at_least", value: "1" },
    ] },
  ],
});

const { browser, ext } = await launch({ headless: process.argv.includes("--headless") });
try {
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  const practice = async (f) => {
    const d = (await send({ type: "import", file: f })).value;
    // Press Practice like a person, so Firefox's site grant happens in a real click.
    const btn = `[data-id="${d.id}"] button[data-act=practice]`;
    await until(() => side.$(btn));
    const before = (await send({ type: "state" })).value.log.length;
    await side.click(btn);
    const r = await until(async () => { const log = (await send({ type: "state" })).value.log; return log.length > before && log.at(-1).orderId === d.id ? log.at(-1) : null; });
    return { d, r };
  };

  let { d, r } = await practice(SHOES);
  const names = r.told.map((t) => t.split(" (")[0]).sort();
  // In 9.5–10.5: Crimper Pro $99 (under 105), Slab Slipper $129 was $179 (28% off), Big Wall $150 was $160 (6% off: out).
  check(r.ok && JSON.stringify(names) === JSON.stringify(["Crimper Pro", "Slab Slipper"]), "shoes: in size range and under $105 or 25%+ off", JSON.stringify(r.told));
  check(r.told.some((t) => /Slab Slipper \(Men's 9\.5\) \$129\.00 — 28% off/.test(t)), "percent off is worked out from the two prices (28%)", JSON.stringify(r.told));
  const card = await side.$eval("#drafts", (e) => e.textContent);
  check(/Every week/.test(card) && /or\s+off is at least 25/.test(card), "the draft card says “Every week” and shows the “or”", card.slice(0, 600));
  await send({ type: "discard", id: d.id });

  ({ d, r } = await practice(RAIN("wet")));
  check(r.ok && r.told.length === 4, "rain (wet day): 0.3 in total passes the total check, though none falls at commute times", JSON.stringify(r.steps.at(-1)));
  await send({ type: "discard", id: d.id });
  ({ d, r } = await practice(RAIN("commute")));
  check(r.ok && r.told.length === 2 && r.told.some((t) => /^4:30 pm/.test(t)), "rain (commute): only 0.06 in, but rain at 8am and 4:30pm passes the time checks", JSON.stringify(r.steps.at(-2)));
  check(r.matches?.length === 2 && r.matches.every((m) => /\/hourly\?rain=commute$/.test(m.url)) && /^8 am: 0\.03/.test(r.matches[0].line), "rain matches are the rainy hours, linking to the forecast page", JSON.stringify(r.matches));
  await send({ type: "discard", id: d.id });
  ({ d, r } = await practice(RAIN("dry")));
  check(r.ok && r.told.length === 0, "rain (dry day): nothing to tell", JSON.stringify(r.steps));

  // Daily at 7: approve and look at the timer.
  await send({ type: "approve", id: d.id });
  const alarm = await until(async () => (await side.evaluate(() => browser.alarms.getAll())).find((a) => a.name === `order:${d.id}`));
  const when = new Date(alarm.scheduledTime);
  check(when.getHours() === 7 && when.getMinutes() === 0 && alarm.periodInMinutes === 1440 && when > new Date() && when - new Date() <= 864e5, "a daily order is timed for the next 7:00 am, then every 24 hours", when.toString());
  const card2 = await side.$eval("#orders", (e) => e.textContent);
  check(/Every day at 7:00/.test(card2), "its card says “Every day at 7:00 AM”", card2.slice(0, 200));
  await send({ type: "cancel", id: d.id });

  // Two weeks: first check runs at approval, not two weeks later.
  const flights = file({ ...SHOES.draft, title: "Fortnightly", trigger: { kind: "every", minutes: 20160 } });
  const fd = (await send({ type: "import", file: flights })).value;
  await send({ type: "approve", id: fd.id });
  const first = await until(async () => (await send({ type: "state" })).value.log.find((x) => x.orderId === fd.id && x.why === "schedule"), 30_000);
  check(first && first.told.length === 2, "an every-2-weeks order does its first check right after approval");
  const a2 = (await side.evaluate(() => browser.alarms.getAll())).find((a) => a.name === `order:${fd.id}`);
  check(a2?.periodInMinutes === 20160, "and then every 20160 minutes (2 weeks)");
  check(first.matches?.length === 2 && first.matches.every((m) => m.new && /^http:\/\/maple-rentals\.test:8090\/shoes\//.test(m.url)), "its matches list each shoe with a link, marked new", JSON.stringify(first.matches));
  const again = (await send({ type: "run", id: fd.id })).value;
  check(again.told.length === 0 && again.matches?.length === 2 && again.matches.every((m) => !m.new), "a later run with nothing new still lists the matches, not marked new", JSON.stringify(again.matches));
  await side.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  const links = await side.$$eval(`[data-id="${fd.id}"] ul.matches a`, (as) => as.map((a) => [a.textContent, a.href]));
  check(links.length === 2 && links.some(([t, h]) => /Slab Slipper/.test(t) && /slab-slipper/.test(h)), "the order card shows them as links", JSON.stringify(links));
  await side.screenshot({ path: "/tmp/mo-matches.png" }).catch(() => {});
  const head = `[data-id="${fd.id}"] h3.toggle`;
  await side.click(head);
  const folded = await side.$eval(`[data-id="${fd.id}"]`, (c) => c.classList.contains("collapsed") && getComputedStyle(c.querySelector(".body")).display === "none" && c.querySelector(".short").textContent);
  check(!!folded && /2 matches/.test(folded), "clicking an order's title folds it to one line", String(folded));
  await side.screenshot({ path: "/tmp/mo-folded.png" }).catch(() => {});
  await side.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await send({ type: "run", id: fd.id }); // a refresh must keep it folded
  await side.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  check(await side.$eval(`[data-id="${fd.id}"]`, (c) => c.classList.contains("collapsed")), "and it stays folded when the sidebar refreshes");
  await side.click(head);
  check(await side.$eval(`[data-id="${fd.id}"]`, (c) => !c.classList.contains("collapsed")), "clicking again unfolds it");
  await send({ type: "cancel", id: fd.id });

  // Flexible dates, Google-style: click the date grid open, then Scroll right + Scroll down 20 times
  // (each moves departures and returns a day), keep 3-5 day trips under $400, one line per trip.
  {
    const f = file({ title: "Flexible flights", steps: [
      { do: "open", url: SITE + "/grid" },
      { do: "click", label: "Date grid" },
      { do: "collect", items: "[role=dialog] [role=button][aria-label*=' to ']", key: "label", fields: [{ name: "label", selector: "", attribute: "aria-label" }] },
      { do: "page_through", labels: ["Scroll right", "Scroll down"], times: 20 },
      { do: "compute", name: "price", from: ["label"], how: "number" },
      { do: "compute", name: "trip_days", from: ["label"], how: "days_between" },
      { do: "compute", name: "trip", from: ["label"], how: "dates" },
      { do: "keep", field: "price", test: "less_than", value: "400" },
      { do: "keep", field: "trip_days", test: "between", value: "3..5" },
      { do: "only_new", field: "trip" },
      { do: "notify", title: "{count} cheap trips", line: "{trip}: ${price} ({trip_days} days)", only_if: [] },
    ] });
    const o = (await send({ type: "import", file: f })).value;
    await send({ type: "approve", id: o.id });
    const rr = (await send({ type: "run", id: o.id })).value;
    const trips = rr.told.map((t) => t.split(":")[0]).sort();
    check(rr.ok && /Clicked “Scroll right” and “Scroll down” 20 times/.test(JSON.stringify(rr.steps)), "clicks Date grid, then Scroll right and Scroll down 20 times", rr.error + " " + JSON.stringify(rr.steps.map((x) => x.note)));
    check(JSON.stringify(trips) === JSON.stringify(["Dec 20–Dec 23", "Dec 20–Dec 24", "Dec 20–Dec 25", "Dec 9–Dec 12", "Dec 9–Dec 13", "Dec 9–Dec 14"]), "finds all 6 cheap 3-5 day trips across the month, each once", JSON.stringify(rr.told));
    check(rr.told.some((t) => /^Dec 9–Dec 13: \$350 \(4 days\)$/.test(t)), "trip length and dates are worked out from the label");
    // The background-safe way: open the grid at four starting weeks instead of scrolling.
    const f2 = file({ title: "Flexible flights by week", steps: [
      { do: "open", url: SITE + "/grid?dep=1" },
      { do: "click", label: "Date grid" },
      { do: "collect", items: "[role=dialog] [role=button][aria-label*=' to ']", key: "label", fields: [{ name: "label", selector: "", attribute: "aria-label" }] },
      { do: "read_also", urls: [6, 11, 16, 21].map((d) => `${SITE}/grid?dep=${d}`) },
      ...f.draft.steps.slice(4),
    ] });
    const o2 = (await send({ type: "import", file: f2 })).value;
    await send({ type: "approve", id: o2.id });
    const r2 = (await send({ type: "run", id: o2.id })).value;
    const trips2 = r2.told.map((t) => t.split(":")[0]).sort();
    check(r2.ok && JSON.stringify(trips2) === JSON.stringify(trips), "opening the grid at 5 starting dates, 5 days apart, finds the same 6 trips, with no scrolling", JSON.stringify(r2.told) + " " + JSON.stringify(r2.steps.map((x) => x.note)));
    await send({ type: "cancel", id: o2.id });
    const card = await side.$eval(`[data-id="${o.id}"]`, (e) => e.textContent);
    check(/Clicks\s*“Date grid”, “Scroll right”, “Scroll down” — only to show information/.test(card), "the card names everything the order may click", card.slice(0, 400));
    await send({ type: "cancel", id: o.id });
    const bad = file({ title: "Sneaky booker", steps: [{ do: "open", url: SITE + "/grid" }, { do: "click", label: "Book this flight" }] });
    const ob = (await send({ type: "import", file: bad })).value;
    await send({ type: "approve", id: ob.id });
    const rb = (await send({ type: "run", id: ob.id })).value;
    check(!rb.ok && /Refused to click “Book this flight”/.test(rb.error), "an order can't click a button that books", rb.error);
    await send({ type: "cancel", id: ob.id });
  }
  // A list drawn by JavaScript seconds after the page loads is still read.
  {
    const f = file({ title: "Slow list", steps: [{ do: "open", url: SITE + "/slow" }, { do: "collect", items: "li.late", key: "link", fields: [{ name: "name", selector: "a", attribute: "text" }, { name: "link", selector: "a", attribute: "href" }] }, { do: "notify", title: "{count}", line: "{name}", only_if: [] }] });
    const o = (await send({ type: "import", file: f })).value;
    await send({ type: "approve", id: o.id });
    const rr = (await send({ type: "run", id: o.id })).value;
    check(rr.ok && rr.found === 3, "a list that appears seconds after the page loads is still read", rr.error + " " + JSON.stringify(rr.steps));
    await send({ type: "cancel", id: o.id });
  }
  // Login and bot-check pages are reported as such, not "repaired".
  for (const [path, re, what] of [["/account", /log in again/, "a login page"], ["/blocked", /blocked the check/, "a bot-check page"]]) {
    const f = file({ title: what, steps: [{ do: "open", url: SITE + path }, { do: "collect", items: ".row", key: "x", fields: [{ name: "x", selector: "", attribute: "text" }] }] });
    const o = (await send({ type: "import", file: f })).value;
    await send({ type: "approve", id: o.id });
    const rr = (await send({ type: "run", id: o.id })).value;
    check(!rr.ok && re.test(rr.error) && !rr.repaired && rr.modelCalls.local + rr.modelCalls.cloud === 0, `${what} says so, with no repair attempt`, rr.error);
    await send({ type: "cancel", id: o.id });
  }
} catch (e) {
  console.log("FAIL crashed:", e.stack); failed++;
} finally {
  await browser.close(); site.kill();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
