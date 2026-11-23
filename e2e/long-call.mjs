// A writer call that takes 45 s must still get its answer. (An MV3 event page is put to
// sleep after 30 s idle and the answer is lost; the persistent background page fixes that.)
// Usage: node e2e/long-call.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { launch, sidebarPage, sleep } from "../lib/firefox.mjs";
const slow = createServer((req, res) => { setTimeout(() => { res.writeHead(500); res.end("slow"); }, 45000); }).listen(11436, "127.0.0.1");
const site = spawn(process.execPath, ["test-site/server.mjs", "8090"]);
await sleep(400);
const { browser, ext } = await launch({ headless: true });
try {
  const side = await sidebarPage(browser, ext);
  await side.evaluate(() => browser.runtime.sendMessage({ type: "settings", settings: { writer: "local", ollamaUrl: "http://127.0.0.1:11436" } }));
  const t0 = Date.now();
  const r = await side.evaluate(() => browser.runtime.sendMessage({ type: "draft", sentence: "x", usePage: false }).then((v) => JSON.stringify(v), (e) => "REJECTED: " + e.message));
  const ok = /Ollama answered 500/.test(r) && Date.now() - t0 > 40000;
  console.log(`${ok ? "ok  " : "FAIL"} a 45-second model call still gets its answer (${Math.round((Date.now() - t0) / 1000)} s: ${r})`);
  process.exitCode = ok ? 0 : 1;
} finally { await browser.close(); site.kill(); slow.close(); }
