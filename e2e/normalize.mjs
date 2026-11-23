// Unit checks for the clean-up applied to every draft (src/normalize.ts).
// Usage: node e2e/normalize.mjs
import * as esbuild from "esbuild";
const { outputFiles } = await esbuild.build({ entryPoints: ["src/normalize.ts"], bundle: true, format: "esm", write: false, platform: "neutral" });
const { normalize, timingFrom } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
let failed = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${!ok ? `\n     ${extra}` : ""}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const [s, want] of [
  ["tell me about any purchase at a liquor store once a week", { kind: "every", minutes: 10080 }],
  ["Every day at 7am, check the forecast", { kind: "daily", at: "07:00" }],
  ["each morning at 6:30 check", { kind: "daily", at: "06:30" }],
  ["daily at 3:15 pm", { kind: "daily", at: "15:15" }],
  ["Every 2 weeks, tell me about flights", { kind: "every", minutes: 20160 }],
  ["every two hours", { kind: "every", minutes: 120 }],
  ["Every hour, tell me about purchases", { kind: "every", minutes: 60 }],
  ["hide sponsored stories on this site", null],
]) check(eq(timingFrom(s), want), `“${s}” → ${JSON.stringify(want)}`, JSON.stringify(timingFrom(s)));

// The broken bank draft: manual trigger, no open step, reads the page.
const broken = { can_do: true, cannot_reason: "", title: "Transaction List", summary: "", trigger: { kind: "manual" }, sites: [], model: "local",
  steps: [{ do: "collect", items: ".txn", key: "id", fields: [{ name: "merchant", selector: ".m", attribute: "text" }] }, { do: "judge", question: "Is this an alcohol purchase?" }] };
const fixed = normalize(broken, "tell me about any purchase at a liquor store, wine shop, brewery, bar or bottle shop once a week", "https://global.americanexpress.com/activity/recent");
check(eq(fixed.trigger, { kind: "every", minutes: 10080 }), "the stated “once a week” replaces “only when you press Run”");
check(fixed.steps[0].do === "open" && fixed.steps[0].url === "https://global.americanexpress.com/activity/recent", "a missing open step becomes the page it was written on");
check(eq(fixed.sites, ["https://global.americanexpress.com"]), "and that site is added to what it may touch");
check(fixed.steps.at(-1).do === "notify" && fixed.model === "local", "a notify step is added; the judge stays on the local model");
const visit = normalize({ ...broken, trigger: { kind: "on_visit", match: "https://x.com/" } }, "whenever I open x", "https://x.com/a");
check(!visit.steps.some((s) => s.do === "open"), "an on-visit order isn't given an open step");
const chosen = normalize({ ...broken, trigger: { kind: "every", minutes: 30 } }, "once a week", "https://a.com");
check(eq(chosen.trigger, { kind: "every", minutes: 30 }), "a schedule the writer did choose is left alone");
// Dated addresses ({today+N}).
{
  const { outputFiles: u } = await esbuild.build({ entryPoints: ["src/urls.ts"], bundle: true, format: "esm", write: false, platform: "neutral" });
  const { datedUrl } = await import("data:text/javascript;base64," + Buffer.from(u[0].text).toString("base64"));
  const now = new Date(2026, 10, 20, 9, 0); // Nov 20 2026
  check(datedUrl("https://x.com/?q=on%20{today+10}%20returning%20{today+14}", now) === "https://x.com/?q=on%202026-11-30%20returning%202026-12-04", "{today+10} and {today+14} become Nov 30 and Dec 4");
  check(datedUrl("https://x.com/?q=on%20%7Btoday%2B45%7D", now) === "https://x.com/?q=on%202027-01-04", "URL-encoded {today+45} works and crosses the year");
  check(datedUrl("https://x.com/{today}", now) === "https://x.com/2026-11-20", "{today} is today");
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
