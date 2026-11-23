// Private-page mode, end to end with a stand-in for Claude (no paid calls): the
// writer must receive the page's layout with every letter and digit masked, and the
// order must still read the real page on this computer.
// Usage: node e2e/private.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { launch, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";

let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? `\n     ${extra}` : ""}`); if (!ok) failed++; };
// The stand-in relay: records the request, answers with an order like Claude's.
let sent = "";
const ORDER = { can_do: true, cannot_reason: "", title: "Alcohol purchases", summary: "Lists purchases at shops that sell alcohol.", trigger: { kind: "manual" }, sites: [SITE], model: "none",
  steps: [{ do: "open", url: `${SITE}/xxxx/xxxxxxxx/9999` }, { do: "collect", items: "div.tx-row", key: "link", fields: [{ name: "date", selector: ".tx-date", attribute: "text" }, { name: "merchant", selector: ".tx-desc a", attribute: "text" }, { name: "amount", selector: ".tx-amt", attribute: "text" }, { name: "link", selector: ".tx-desc a", attribute: "href" }] }, { do: "notify", title: "{count} purchases", line: "{date} {merchant} {amount}", only_if: [] }] };
const relay = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    sent = body;
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(ORDER) }] }));
  });
}).listen(8092, "127.0.0.1");
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
const { browser, ext } = await launch({ headless: true });
try {
  const web = await browser.newPage();
  await web.goto(`${SITE}/bank/activity/4417`);
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  await send({ type: "settings", settings: { writer: "cloud", apiKey: "sk-ant-api03-test", useRelay: true, relayUrl: "http://127.0.0.1:8092" } });
  await web.bringToFront(); await sleep(400);
  await side.evaluate(() => { document.querySelector("#sentence").value = "Tell me about any purchase at a liquor store once a week"; document.querySelector("#layout-only").checked = true; });
  await side.click("#draft");
  const s = await until(async () => { const v = (await send({ type: "state" })).value; return v.drafts.length ? v : null; }, 60_000);
  const body = JSON.parse(sent || "{}");
  const prompt = JSON.stringify(body.messages ?? "");
  for (const secret of ["TOTAL WINE", "Total Wine", "SAFEWAY", "BREAKSIDE", "48.12", "83.40", "4417", "Nov 18", "Maple Bank"]) {
    check(!prompt.includes(secret), `the writer never sees “${secret}”`);
  }
  check(/XXXXX XXXX & XXXX #9999/.test(prompt) && /\$99\.99/.test(prompt), "it sees the shapes instead (“XXXXX XXXX & XXXX #9999”, “$99.99”)", prompt.slice(0, 300));
  check(/tx-row/.test(prompt) && /tx-amt/.test(prompt), "and the page's structure (class names), so it can pick selectors");
  check(/xxxx\/xxxxxxxx\/9999/.test(prompt) && !/bank\/activity\/4417/.test(prompt), "the page address is masked too");
  const d = s.drafts.at(-1);
  check(d.layoutOnly && d.steps[0].url === `${SITE}/bank/activity/4417`, "the order still opens the real page", d.steps[0].url);
  check(d.trigger.kind === "every" && d.trigger.minutes === 10080, "“once a week” set the schedule");
  const pr = s.log.filter((x) => x.orderId === d.id).at(-1);
  check(pr?.ok && pr.told.some((t) => /TOTAL WINE & MORE #1123 \$48\.12/.test(t)), "the practice run reads the real transactions, on this computer", JSON.stringify(pr?.told ?? pr));
  const card = await side.$eval("#drafts", (e) => e.textContent);
  check(/layout only, not its text/.test(card), "the draft card says the writer saw layout only");
} catch (e) { console.log("FAIL crashed:", e.stack); failed++; }
finally { await browser.close(); site.kill(); relay.close(); }
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
