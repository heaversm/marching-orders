// Launches a separate, downloaded Firefox (never the everyday Firefox.app)
// with the built extension installed, for tests and demos.
// Env: FIREFOX (binary path) overrides the downloaded copy.
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = join(root, "dist-test");

function downloadedFirefox() {
  const base = join(root, ".browsers/firefox");
  const dir = readdirSync(base).filter((d) => d.startsWith("mac_")).sort().at(-1);
  if (!dir) throw new Error("No test Firefox. Run: npx @puppeteer/browsers install firefox@stable --path .browsers");
  return join(base, dir, "Firefox.app/Contents/MacOS/firefox");
}
export const FIREFOX = process.env.FIREFOX ?? downloadedFirefox();
if (FIREFOX.startsWith("/Applications/Firefox.app")) throw new Error("Refusing to drive the everyday Firefox.app");

export const SITES = ["maple-rentals.test", "daily-ledger.test"];
export const SITE = "http://maple-rentals.test:8090";
export const NEWS = "http://daily-ledger.test:8090";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The extension's UUID is fixed per gecko id, so its page URLs are known in advance.
export function extension() {
  const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf8"));
  const id = manifest.browser_specific_settings.gecko.id;
  const hex = createHash("sha256").update(id).digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { id, uuid, base: `moz-extension://${uuid}/` };
}

export async function launch({ headless = true, profile, dist = DIST, extraPrefs = {} } = {}) {
  const ext = extension();
  process.env.MOZ_DISABLE_UPDATE_PROCESSING = "1";
  const browser = await puppeteer.launch({
    browser: "firefox", executablePath: FIREFOX, headless,
    userDataDir: profile ?? mkdtempSync(join(tmpdir(), "marching-orders-")),
    args: ["-remote-allow-system-access"],
    env: { ...process.env, MOZ_DISABLE_UPDATE_PROCESSING: "1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [ext.id]: ext.uuid }),
      // Grant optional site access without the prompt (tests can't click Firefox's own dialogs).
      "extensions.webextOptionalPermissionPrompts": false,
      "app.update.disabledForTesting": true,
      // Invented site names for the test sites, so access to them is a real grant
      // (localhost is pre-granted for the local model).
      "network.dns.localDomains": SITES.join(","),
      // Keep orders and settings when Firefox closes (a temporary add-on is removed on quit).
      "extensions.webextensions.keepStorageOnUninstall": true,
      "extensions.webextensions.keepUuidOnUninstall": true,
      ...extraPrefs,
    },
  });
  await browser.installExtension(dist);
  return { browser, ext };
}

// Firefox won't let automation navigate to moz-extension pages. The test build
// turns any tab that opens /__sidebar into the sidebar page instead.
export async function sidebarPage(browser, ext, site = SITE) {
  const url = ext.base + "sidebar.html";
  const page = await browser.newPage();
  page.goto(`${site}/__sidebar`, { timeout: 0 }).catch(() => {});
  const deadline = Date.now() + 30_000;
  for (;;) {
    // page.url() can lag behind here, so ask the page itself.
    if (await page.evaluate((u) => location.href === u && document.readyState === "complete" && typeof browser === "object", url).catch(() => false)) return page;
    if (Date.now() > deadline) throw new Error(`Timed out opening ${url}`);
    await sleep(250);
  }
}
export async function until(fn, timeoutMs = 60_000, every = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${fn.toString().slice(0, 120)}`);
    await sleep(every);
  }
}
export { sleep };
