// The Change button: edit an order's sentence, draft a new version (stand-in for Claude,
// no paid calls), and approve it. The new version replaces the old one and keeps its
// record of what was already reported. Usage: node e2e/change.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { launch, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";

let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? `\n     ${extra}` : ""}`); if (!ok) failed++; };
const order = (max, title) => ({ can_do: true, cannot_reason: "", title, summary: `2-beds under $${max}.`, trigger: { kind: "every", minutes: 30 }, sites: [SITE], model: "none",
  steps: [
    { do: "open", url: `${SITE}/listings` },
    { do: "collect", items: "article.listing", key: "link", fields: [{ name: "title", selector: "h2.title", attribute: "text" }, { name: "price", selector: ".price", attribute: "text" }, { name: "beds", selector: ".beds", attribute: "text" }, { name: "link", selector: "h2.title a", attribute: "href" }] },
    { do: "keep", field: "beds", test: "contains", value: "2" },
    { do: "keep", field: "price", test: "less_than", value: String(max) },
    { do: "only_new", field: "" },
    { do: "notify", title: "New 2-beds", line: "{title} — {price}", only_if: [] },
  ] });
let prompt = "";
const relay = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    prompt = JSON.stringify(JSON.parse(body).messages);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(order(3200, "2-beds under $3,200")) }] }));
  });
}).listen(8094, "127.0.0.1");
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
await fetch("http://localhost:8090/admin/reset");
const { browser, ext } = await launch({ headless: true });
try {
  const web = await browser.newPage();
  await web.goto(`${SITE}/listings`);
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  const state = async () => (await send({ type: "state" })).value;
  await send({ type: "settings", settings: { writer: "cloud", apiKey: "sk-ant-api03-test", useRelay: true, relayUrl: "http://127.0.0.1:8094" } });

  // The original order, approved and run: it has told about the 2 listings under $2,800.
  const sentence = "Tell me when a 2-bed under $2,800 shows up on this page";
  const a = (await send({ type: "import", file: { format: "marching-orders/1", sentence, sharedAt: "", draft: order(2800, "2-beds under $2,800") } })).value;
  await until(() => side.$(`[data-id="${a.id}"] button[data-act=approve]`));
  await side.click(`[data-id="${a.id}"] button[data-act=approve]`);
  const first = await until(async () => (await state()).log.find((x) => x.orderId === a.id && x.why === "schedule"));
  check(first.told.length === 2, "the original order has told about 2 listings", JSON.stringify(first.told));

  // Change: the sentence goes back in the box, with a note saying what's being changed.
  await side.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await side.click(`[data-id="${a.id}"] button[data-act=change]`);
  const box = await side.$eval("#sentence", (e) => e.value);
  const note = await side.$eval("#changing", (e) => (e.hidden ? "" : e.textContent));
  check(box === sentence, "Change puts the order's sentence back in the box");
  check(/Changing 2-beds under \$2,800/.test(note), "and says which order is being changed", note);

  // Edit and draft.
  await side.evaluate(() => { document.querySelector("#sentence").value = "Tell me when a 2-bed under $3,200 shows up on this page"; });
  await web.bringToFront(); await sleep(300);
  await side.click("#draft");
  const s1 = await until(async () => { const v = await state(); return v.drafts.length ? v : null; }, 60_000);
  const d = s1.drafts[0];
  check(/under \$3,200/.test(prompt), "the writer got the edited sentence");
  check(d.replaces === a.id, "the new draft is marked as replacing the original");
  await side.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const card = await side.$eval(`[data-id="${d.id}"]`, (e) => e.textContent);
  check(/Replaces “2-beds under \$2,800” when you approve it/.test(card), "its card says what it replaces", card.slice(0, 300));
  check(s1.orders.some((o) => o.id === a.id), "the original keeps running until the new one is approved");
  check(await side.$eval("#changing", (e) => e.hidden), "the change note goes away once the draft is made");

  // Approve: the original is gone, the new one runs and doesn't repeat what was reported.
  await side.click(`[data-id="${d.id}"] button[data-act=approve]`);
  const s2 = await until(async () => { const v = await state(); return v.log.find((x) => x.orderId === d.id && x.why === "schedule") ? v : null; });
  check(!s2.orders.some((o) => o.id === a.id) && s2.orders.some((o) => o.id === d.id), "approving replaces the original with the new version");
  check(!(await side.evaluate(() => browser.alarms.getAll())).some((x) => x.name === `order:${a.id}`), "the original's timer is gone");
  const run = s2.log.find((x) => x.orderId === d.id && x.why === "schedule");
  check(run.told.length === 1 && /Renovated 2-bed/.test(run.told[0]), "its first run reports only the newly included listing, not the 2 already reported", JSON.stringify(run.told));

  // Changing your mind: Keep the old one clears the box and the note.
  await side.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  await side.click(`[data-id="${d.id}"] button[data-act=change]`);
  await side.click("#changing button[data-act=stop-change]");
  check(await side.$eval("#changing", (e) => e.hidden) && (await side.$eval("#sentence", (e) => e.value)) === "", "“Keep the old one” cancels the change");
} catch (e) { console.log("FAIL crashed:", e.stack); failed++; }
finally { await browser.close(); site.kill(); relay.close(); }
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
