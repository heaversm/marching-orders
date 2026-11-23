// Two people, two separate Firefox profiles. Alex approves and runs an order, presses
// Share (the real button; the file lands in a downloads folder), and Sam loads it with
// the real "Import an order…" picker, then practices, approves and runs it.
// Uses the invented rentals site; no AI calls. Usage: node e2e/share.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";

let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? `\n     ${extra}` : ""}`); if (!ok) failed++; };
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
const admin = (p) => fetch(`http://localhost:8090${p}`).then((r) => r.text());
await admin("/admin/reset");

const ORDER = { format: "marching-orders/1", sentence: "Tell me when a 2-bed under $2,800 shows up on this page", sharedAt: "", draft: {
  can_do: true, cannot_reason: "", title: "Cheap 2-beds on Maple Rentals", summary: "Checks Maple Rentals every 30 minutes for new 2-beds under $2,800.",
  trigger: { kind: "every", minutes: 30 }, sites: [SITE], model: "none",
  steps: [
    { do: "open", url: `${SITE}/listings` },
    { do: "collect", items: "article.listing", key: "link", fields: [{ name: "title", selector: "h2.title", attribute: "text" }, { name: "price", selector: ".price", attribute: "text" }, { name: "beds", selector: ".beds", attribute: "text" }, { name: "link", selector: "h2.title a", attribute: "href" }] },
    { do: "keep", field: "beds", test: "contains", value: "2" },
    { do: "keep", field: "price", test: "less_than", value: "2800" },
    { do: "only_new" },
    { do: "notify", title: "New 2-beds under $2,800", line: "{title} — {price}", only_if: [] },
  ] } };

const downloads = mkdtempSync(join(tmpdir(), "mo-downloads-"));
const prefs = { "browser.download.folderList": 2, "browser.download.dir": downloads, "browser.download.useDownloadDir": true, "browser.download.always_ask_before_handling_new_types": false, "browser.download.panel.shown": true };
const alex = await launch({ headless: true, extraPrefs: prefs });
const sam = await launch({ headless: true });
try {
  // ---- Alex: an order that has already run and reported things ----
  const a = await sidebarPage(alex.browser, alex.ext);
  const sendA = (m) => a.evaluate((m) => browser.runtime.sendMessage(m), m);
  const d = (await sendA({ type: "import", file: ORDER })).value;
  await until(() => a.$(`[data-id="${d.id}"] button[data-act=approve]`));
  await a.click(`[data-id="${d.id}"] button[data-act=approve]`);
  const first = await until(async () => (await sendA({ type: "state" })).value.log.find((x) => x.orderId === d.id && x.why === "schedule"));
  check(first.told.length === 2, "Alex's order runs and tells Alex about 2 listings", JSON.stringify(first.told));
  await admin("/admin/add?title=Alex%20saw%20this%20one&price=2400&beds=2");
  const second = (await sendA({ type: "run", id: d.id })).value;
  check(second.told.length === 1, "and later about 1 more");

  // ---- Alex presses Share ----
  await a.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await a.click(`[data-id="${d.id}"] button[data-act=share]`);
  const name = await until(async () => readdirSync(downloads).find((f) => f.endsWith(".marching-order.json")), 20_000).catch(() => null);
  if (!name) console.log("     status:", await a.$eval("#status", (e) => e.textContent), "| downloads:", JSON.stringify(await a.evaluate(async () => (await browser.downloads.search({})).map((d) => [d.filename, d.state, d.error]))));
  check(!!name, "Share saves a .marching-order.json file to the downloads folder", readdirSync(downloads).join(", "));
  if (!name) throw new Error("no shared file");
  console.log(`     file: ${name}`);
  const raw = readFileSync(join(downloads, name), "utf8");
  const file = JSON.parse(raw);
  check(file.format === "marching-orders/1" && file.draft.steps.length === 6 && file.sentence === ORDER.sentence, "the file holds the sentence and all 6 steps");
  check(!/Alex saw this one|Sunny 2-bed|WIRE DEPOSIT/.test(raw), "and nothing Alex's order found");
  check(!("id" in file.draft) && !("approved" in file.draft) && !("repairs" in file.draft) && !/"seen|log"/.test(raw), "and none of Alex's state (id, approval, history, what was reported)");

  // ---- Sam imports it with the real file picker ----
  const s = await sidebarPage(sam.browser, sam.ext);
  const sendS = (m) => s.evaluate((m) => browser.runtime.sendMessage(m), m);
  // Automation can't fill a file picker on an extension page, so give the picker the
  // exact downloaded file and fire its change event; the sidebar's own import code runs.
  await s.evaluate((text, fname) => {
    const input = document.querySelector("#import");
    const dt = new DataTransfer();
    dt.items.add(new File([text], fname, { type: "application/json" }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, raw, name);
  const draft = await until(async () => (await sendS({ type: "state" })).value.drafts[0]);
  check(draft.from === "a shared file" && !draft.approved, "Sam sees it as a draft, marked as from a shared file, not running");
  const card = await s.$eval(`[data-id="${draft.id}"]`, (e) => e.textContent);
  check(/from a shared file/.test(card) && /May touch\s*maple-rentals\.test:8090/.test(card), "the card shows where it came from and what it may touch");
  check(!(await s.evaluate(() => browser.permissions.contains({ origins: ["http://maple-rentals.test/*"] }))), "Sam's Firefox hasn't granted the site yet");

  // Practice, then approve (each asks Sam's Firefox for the site).
  await s.click(`[data-id="${draft.id}"] button[data-act=practice]`);
  const pr = await until(async () => (await sendS({ type: "state" })).value.log.find((x) => x.orderId === draft.id && x.why === "practice"));
  check(pr.ok && pr.told.length === 3, "Sam's practice run works on Sam's machine: 3 matches", JSON.stringify(pr.told));
  check(await s.evaluate(() => browser.permissions.contains({ origins: ["http://maple-rentals.test/*"] })), "and Sam's Firefox granted the site through the button");
  await s.click(`[data-id="${draft.id}"] button[data-act=approve]`);
  const sFirst = await until(async () => (await sendS({ type: "state" })).value.log.find((x) => x.orderId === draft.id && x.why === "schedule"));
  check(sFirst.told.length === 3, "Sam's first real run reports all 3 current matches (Sam's copy hasn't seen any)", JSON.stringify(sFirst.told));
  const sAgain = (await sendS({ type: "run", id: draft.id })).value;
  check(sAgain.told.length === 0, "and then only new ones");

  // Each person's results stay in their own browser.
  const aState = (await sendA({ type: "state" })).value, sState = (await sendS({ type: "state" })).value;
  check(aState.orders.length === 1 && aState.orders[0].id === d.id && aState.log.every((x) => x.orderId === d.id) && aState.log.filter((x) => x.orderId === d.id && x.why !== "practice").length === 2, "Alex's browser still has only Alex's order and Alex's 2 runs", JSON.stringify(aState.log.map((x) => [x.orderId, x.why])));
  check(sState.orders.length === 1 && sState.log.every((x) => x.orderId === draft.id), "Sam's browser has only Sam's copy and Sam's runs");
} catch (e) { console.log("FAIL crashed:", e.stack); failed++; }
finally { await alex.browser.close(); await sam.browser.close(); site.kill(); }
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
