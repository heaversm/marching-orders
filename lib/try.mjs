// Opens a separate Firefox (the downloaded test copy, not your everyday one)
// with Marching Orders installed and the two test sites in tabs. Orders and
// settings (including an API key you type in) stay in .profile/ between runs.
// Close the Firefox window to stop. Usage: npm run try
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, root, SITE, NEWS } from "./firefox.mjs";
import { startRelay } from "./relay.mjs";

const profile = join(root, ".profile");
mkdirSync(profile, { recursive: true });
const site = spawn(process.execPath, [join(root, "test-site/server.mjs"), "8090"], { stdio: "inherit" });
// For Anthropic organizations that refuse calls from browsers; harmless otherwise.
const relay = await startRelay().catch(() => null); // already running elsewhere is fine
const { browser } = await launch({ headless: !!process.env.HEADLESS, profile, dist: join(root, "dist") });
const news = await browser.newPage();
await news.goto(`${NEWS}/news`);
const listings = await browser.newPage();
await listings.goto(`${SITE}/listings`);
for (const p of await browser.pages()) if (p !== news && p !== listings && p.url() === "about:blank") await p.close().catch(() => {});
console.log(`
Marching Orders is open in a separate Firefox.
- The sidebar should be open on the left. If not: View > Sidebar > Marching Orders.
- Test sites: ${SITE}/listings (rentals) and ${NEWS}/news (news).
- Site controls, from any terminal:
    curl "http://localhost:8090/admin/add?title=New%202-bed&price=2500&beds=2"   add a listing
    curl "http://localhost:8090/admin/redesign"                                   change the site's markup
    curl "http://localhost:8090/admin/reset"                                      start over
Close the Firefox window to stop.`);
browser.on("disconnected", () => { site.kill(); relay?.close(); process.exit(0); });
