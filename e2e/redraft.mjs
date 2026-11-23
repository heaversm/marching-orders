// When a practice run fails because the person's tab had something clicked (a selected
// tab), the second draft must be written from the page as the order sees it, opened fresh.
// Uses a stand-in for Claude (no paid calls). Usage: node e2e/redraft.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { launch, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";

let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok && extra ? `\n     ${extra}` : ""}`); if (!ok) failed++; };
const order = (items) => ({ can_do: true, cannot_reason: "", title: "Hours", summary: "", trigger: { kind: "manual" }, sites: [SITE], model: "none",
  steps: [{ do: "open", url: `${SITE}/tabs` }, { do: "collect", items, key: "time", fields: [{ name: "time", selector: "b", attribute: "text" }] }, { do: "notify", title: "{count}", line: "{time}", only_if: [] }] });
const prompts = [];
const relay = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    prompts.push(JSON.stringify(JSON.parse(body).messages));
    // First draft: written from the clicked view. Second: from the fresh view.
    const o = prompts.length === 1 ? order("div.hour-precip") : order("div.hour-default");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(o) }] }));
  });
}).listen(8093, "127.0.0.1");
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
const { browser, ext } = await launch({ headless: true });
try {
  const web = await browser.newPage();
  await web.goto(`${SITE}/tabs`);
  await web.click("#precip"); // the person selects a tab: the layout changes, the address doesn't
  const side = await sidebarPage(browser, ext);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  await send({ type: "settings", settings: { writer: "cloud", apiKey: "sk-ant-api03-test", useRelay: true, relayUrl: "http://127.0.0.1:8093" } });
  await web.bringToFront(); await sleep(400);
  await side.evaluate(() => { document.querySelector("#sentence").value = "Tell me the hours"; });
  await side.click("#draft");
  const s = await until(async () => { const v = (await send({ type: "state" })).value; return v.drafts.length ? v : null; }, 90_000);
  check(prompts.length === 2, "a failed practice run leads to one second draft", String(prompts.length));
  check(/hour-precip/.test(prompts[0]), "the first draft was written from the person's tab (the clicked view)");
  const outline2 = ((prompts[1] ?? "").split("Its outline:")[1] ?? "").split("A practice run")[0];
  check(/hour-default/.test(outline2) && !/hour-precip/.test(outline2), "the second draft's page outline is the page opened fresh (no clicked view)", outline2.slice(0, 400));
  check(/exactly as the order sees it/.test(prompts[1] ?? ""), "and is told why");
  const d = s.drafts.at(-1);
  const pr = s.log.filter((x) => x.orderId === d.id).at(-1);
  check(pr?.ok && pr.found === 3, "its practice run reads the 3 hours", JSON.stringify(pr?.steps));
  const hidden = await side.evaluate(async () => (await browser.tabs.query({})).filter((t) => t.hidden).length);
  check(hidden === 0, "the extra hidden tab is closed");
} catch (e) { console.log("FAIL crashed:", e.stack); failed++; }
finally { await browser.close(); site.kill(); relay.close(); }
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
