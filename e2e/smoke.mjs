// Quick check: extension loads, sidebar page answers, a local-model draft works.
import { spawn } from "node:child_process";
import { launch, sidebarPage, until, sleep, SITE } from "../lib/firefox.mjs";
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"], { stdio: "inherit" });
await sleep(400);
const { browser, ext } = await launch({ headless: true });
try {
  const web = await browser.newPage();
  await web.goto(SITE + "/listings");
  const side = await sidebarPage(browser, ext);
  await web.bringToFront();
  await sleep(500);
  const send = (m) => side.evaluate((m) => browser.runtime.sendMessage(m), m);
  console.log("state page:", (await send({ type: "state" })).value.page);
  await send({ type: "settings", settings: { writer: "local", ollamaUrl: "http://127.0.0.1:11435" } });
  // Click like a person.
  await side.evaluate(() => { document.querySelector("#sentence").value = "Tell me when a 2-bed under $2,800 shows up on this page"; });
  const t0 = Date.now();
  try { await side.click("#draft"); console.log("real click ok"); }
  catch (e) { console.log("real click failed:", e.message.slice(0, 120)); await side.evaluate(() => document.querySelector("#draft").click()); }
  await sleep(1500);
  console.log("status now:", await side.$eval("#status", (e) => e.textContent));
  const st = await until(async () => { const s = (await send({ type: "state" })).value; const status = await side.$eval("#status", (e) => e.className + " " + e.textContent); if (status.includes("error")) return { error: status }; return s.drafts.length ? s : null; }, 300_000, 1000).catch((e) => { console.log("FAILED:", e.message); process.exitCode = 1; return null; });
  if (!st || st.error) throw new Error("no draft: " + st?.error);
  console.log("draft after", Date.now() - t0, "ms");
  console.log(JSON.stringify(st.drafts[0], null, 1));
  console.log(JSON.stringify(st.log.at(-1), null, 1));
  console.log("status:", await side.$eval("#status", (e) => e.textContent));
} finally {
  await browser.close();
  site.kill();
}
