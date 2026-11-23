// Draws the real sidebar (dist/sidebar.html + sidebar.js) as a normal page, fed the
// extension state saved by e2e/capture.mjs, so it can be screenshotted at sidebar width
// and 2x. Nothing about the sidebar's code changes; only `browser` is stood in for.
// Usage: node e2e/render-shots.mjs
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { FIREFOX, root, sleep } from "../lib/firefox.mjs";

const OUT = process.env.SHOTS_DIR ?? join(root, "shots");
const DIST = join(root, "dist");
const shim = (state) => `<script>
const STATE = ${JSON.stringify(state)};
localStorage.setItem("collapsed", JSON.stringify(STATE.collapsed ?? []));
const noop = { addListener() {} };
window.browser = {
  runtime: { sendMessage: async (m) => ({ ok: true, value: m.type === "state" ? STATE : true }), onMessage: noop, getURL: (p) => p },
  tabs: { onActivated: noop, onUpdated: noop },
  permissions: { request: async () => true },
};
</script>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/sidebar.html") {
    const state = JSON.parse(readFileSync(join(OUT, `state-${url.searchParams.get("state")}.json`), "utf8"));
    const html = readFileSync(join(DIST, "sidebar.html"), "utf8").replace("<script src=\"sidebar.js\"", shim(state) + "<script src=\"sidebar.js\"");
    res.writeHead(200, { "content-type": "text/html" }); return res.end(html);
  }
  try {
    const body = readFileSync(join(DIST, url.pathname));
    const type = url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".png") ? "image/png" : "application/octet-stream";
    res.writeHead(200, { "content-type": type }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(8095, "127.0.0.1");

process.env.MOZ_DISABLE_UPDATE_PROCESSING = "1";
const browser = await puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: true, extraPrefsFirefox: { "ui.systemUsesDarkTheme": 1 } });
const H = 1000;
const shots = [
  // name, state, what to do before the shot
  ["side-compose", "compose", async (p, st) => p.evaluate((t) => { document.querySelector("#sentence").value = t; }, st.sentence)],
  ["side-draft-top", "draft", async (p, st) => p.evaluate((s) => { document.querySelector("#status").textContent = s; document.querySelector("#drafts").scrollIntoView({ block: "start" }); window.scrollBy(0, -12); }, st.status)],
  ["side-draft-results", "draft", async (p) => p.evaluate(() => { document.querySelector("#drafts .result").scrollIntoView({ block: "start" }); window.scrollBy(0, -16); })],
  ["side-order", "order", async (p, st) => p.evaluate((s) => { document.querySelector("#status").textContent = s; document.querySelector("#orders").scrollIntoView({ block: "start" }); window.scrollBy(0, -60); }, st.status)],
  ["side-repaired", "repaired", async (p, st) => p.evaluate((ids) => { for (const id of ids) document.querySelector(`[data-id="${id}"] details`)?.setAttribute("open", ""); document.querySelector("#orders").scrollIntoView({ block: "start" }); window.scrollBy(0, -40); }, st.open ?? [])],
  ["side-folded", "folded", async () => {}],
];
try {
  for (const [name, stateName, prep] of shots) {
    const st = JSON.parse(readFileSync(join(OUT, `state-${stateName}.json`), "utf8"));
    const p = await browser.newPage();
    await p.setViewport({ width: 420, height: H, deviceScaleFactor: 2 });
    await p.goto(`http://127.0.0.1:8095/sidebar.html?state=${stateName}`, { waitUntil: "load" });
    await sleep(600);
    await prep(p, st);
    await sleep(300);
    await p.screenshot({ path: join(OUT, `${name}.png`) });
    console.log("shot", name);
    await p.close();
  }
} finally { await browser.close(); server.close(); }
