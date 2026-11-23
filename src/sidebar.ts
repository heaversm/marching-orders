// The sidebar: give an order, review the draft, approve it, and watch what
// your orders have done. All work happens in the background script.
import type { Order, OrderFile, RunRecord, Step, Trigger } from "./order";
import { origin, pattern } from "./urls";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

async function call<T = unknown>(msg: Record<string, unknown>): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as { ok: boolean; value?: T; error?: string };
  if (!res?.ok) throw new Error(res?.error ?? "No answer from the extension");
  return res.value as T;
}

let state: { orders: Order[]; drafts: Order[]; log: RunRecord[]; settings: { apiKey: string; writer: string; localModel: string }; page: string } | null = null;
let busy = "";
// Which order cards are folded to their title; kept between sidebar openings.
const collapsed = new Set<string>(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));

function setStatus(text: string, kind: "" | "busy" | "error" = "") {
  const el = $("status");
  el.className = "status" + (kind === "error" ? " error" : "");
  el.innerHTML = (kind === "busy" ? '<span class="spinner"></span>' : "") + esc(text);
}

// ---------- plain-language rendering ----------
function clock(at: string) {
  const [h, m] = at.split(":").map((x) => parseInt(x));
  const d = new Date(2000, 0, 1, h || 0, m || 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function whenText(t: Trigger) {
  if (t.kind === "daily") return `Every day at ${clock(t.at)}`;
  if (t.kind === "every") {
    const m = t.minutes;
    if (m % 10080 === 0) return m === 10080 ? "Every week" : `Every ${m / 10080} weeks`;
    if (m % 1440 === 0) return m === 1440 ? "Every day" : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  if (t.kind === "on_visit") return `When you open ${t.match.replace(/^https?:\/\//, "")}`;
  return "Only when you press Run";
}
const testWords: Record<string, string> = { less_than: "is under", more_than: "is over", at_most: "is at most", at_least: "is at least", between: "is between", contains: "mentions", not_contains: "doesn't mention", equals: "is" };
const cond = (c: { field: string; test: string; value: string }) => `${esc(c.field)} ${testWords[c.test]} ${esc(c.test === "between" ? c.value.replace("..", " and ") : c.value)}`;
export function stepText(s: Step, model: string) {
  switch (s.do) {
    case "open": return `Open ${esc(s.url.replace(/^https?:\/\//, "").replace(/(?:\{|%7B)today(?:(?:\+|%2B)(\d+))?(?:\}|%7D)/gi, (_m, n) => (n ? `[today+${n}]` : "[today]")))} in a hidden tab`;
    case "read_also": return `Do the same for ${s.urls.length} more page${s.urls.length === 1 ? "" : "s"} (${s.urls.map((u) => esc(u.match(/(?:\{|%7B)today(?:\+|%2B)(\d+)/i)?.[0] ? "today+" + u.match(/(?:\{|%7B)today(?:\+|%2B)(\d+)/i)![1] : host(u))).join(", ")}) and add what they show`;
    case "collect": return `Read each item on the page (${s.fields.map((f) => esc(f.name)).join(", ")})`;
    case "keep": return `Keep ones whose ${cond(s)}`;
    case "keep_any": return `Keep ones whose ${s.tests.map(cond).join(", <b>or</b> ")}`;
    case "compute": {
      const how: Record<string, string> = { percent_off: "% off", minus: "difference", number: "number", hours: "hours", time_of_day: "time of day", day: "which day", days_between: "days between dates", dates: "dates" };
      return `Work out ${esc(s.name)} (${how[s.how]} from ${s.from.map(esc).join(" and ")})`;
    }
    case "judge": return `Ask the ${model === "cloud" ? "cloud" : "local"} model about each: “${esc(s.question)}” <span class="badge ai">AI each run</span>`;
    case "only_new": return "Skip ones it already told you about";
    case "summarize": return `Have the ${model === "cloud" ? "cloud" : "local"} model write: “${esc(s.instruction)}” <span class="badge ai">AI each run</span>`;
    case "notify": {
      const checks = (s.only_if ?? []).map((m) => `${m.measure === "count" ? "at least one" : `the ${m.measure === "sum" ? "total" : m.measure} ${esc(m.field)}`}${m.where.length ? ` where ${m.where.map(cond).join(" and ")}` : ""}${m.measure === "count" ? "" : ` ${testWords[m.test]} ${esc(m.value)}`}`);
      return `Notify you: “${esc(s.title)}”${checks.length ? ` — only if ${checks.join(", <b>or</b> ")}` : ""}`;
    }
    case "click": return `Click “${esc(s.label)}”`;
    case "page_through": return `Click ${s.labels.map((l) => `“${esc(l)}”`).join(" then ")} up to ${s.times} time${s.times === 1 ? "" : "s"}, reading the items again each time`;
    case "hide": return "Hide matching parts of the page";
    case "highlight": return "Outline matching parts of the page";
  }
}
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
function resultHtml(r: RunRecord | undefined, practice: boolean) {
  if (!r) return "";
  const cls = r.ok ? "good" : "bad";
  const reshaped = r.steps.filter((x) => x.do === "hide" || x.do === "highlight");
  const head = r.error
    ? `Didn't work: ${esc(r.error)}`
    : reshaped.length && !r.steps.some((x) => x.do === "collect")
      ? reshaped.map((x) => esc(x.note)).join(" · ")
      : r.told.length
      ? `${practice ? "Practice run: would tell you about" : "Told you about"} ${r.told.length}`
      : r.found
        ? `${practice ? "Practice run: " : ""}found ${r.found}, nothing to report${r.steps.some((s) => s.do === "only_new") ? " that's new" : ""}`
        : r.steps.find((s) => !s.ok)?.note ?? "Nothing found";
  const list = r.told.length ? `<ul>${r.told.slice(0, 6).map((l) => `<li>${esc(l)}</li>`).join("")}${r.told.length > 6 ? `<li>…and ${r.told.length - 6} more</li>` : ""}</ul>` : "";
  const ai = r.modelCalls.local + r.modelCalls.cloud;
  const extra = [r.repaired ? "repaired a step" : "", ai ? `${ai} AI call${ai > 1 ? "s" : ""}` : "no AI used"].filter(Boolean).join(" · ");
  const warn = r.warnings?.length ? `<div class="meta bad">${r.warnings.map(esc).join("<br>")}</div>` : "";
  return `<div class="result ${cls}">${head}${list}${warn}<div class="meta">${extra}</div></div>`;
}
function matchesHtml(r: RunRecord | undefined, practice: boolean) {
  const m = r?.matches ?? [];
  if (!m.length) return "";
  const fresh = m.filter((x) => x.new).length;
  const head = `${practice ? "Would match" : "Matches now"} (${m.length}${!practice && fresh ? `, ${fresh} new` : ""})`;
  const li = (x: { line: string; url: string; new: boolean }) =>
    `<li>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.line)}</a>` : esc(x.line)}${!practice && x.new ? ' <span class="badge ai">new</span>' : ""}</li>`;
  const first = m.slice(0, 5).map(li).join("");
  const rest = m.length > 5 ? `<details><summary>${m.length - 5} more</summary><ul class="matches">${m.slice(5).map(li).join("")}</ul></details>` : "";
  return `<div class="matches-box"><div class="meta">${head}</div><ul class="matches">${first}</ul>${rest}</div>`;
}
function stepsLog(r: RunRecord) {
  return `<ul>${r.steps.map((s) => `<li class="${s.ok ? "" : "bad"}">${esc(s.do)}: ${esc(s.note)}</li>`).join("")}</ul>`;
}

function slip(o: Order) {
  return `<dl>
    <dt>When</dt><dd>${esc(whenText(o.trigger))}</dd>
    <dt>May touch</dt><dd>${o.sites.map((s) => esc(host(s))).join(", ") || "no sites"}</dd>
    ${o.steps.some((x) => x.do === "click" || x.do === "page_through") ? `<dt>Clicks</dt><dd>${[...new Set(o.steps.flatMap((x) => (x.do === "click" ? [x.label] : x.do === "page_through" ? x.labels : [])))].map((l) => `“${esc(l)}”`).join(", ")} — only to show information</dd>` : ""}
    <dt>Sends data</dt><dd>${o.model === "cloud" ? "Page items go to Claude each run" : o.model === "local" ? "Nowhere — the AI step runs on this computer" : "Nowhere"}${o.layoutOnly ? ". The writer saw this page's layout only, not its text" : ""}</dd>
  </dl>`;
}

function draftCard(d: Order) {
  const last = state!.log.filter((r) => r.orderId === d.id).at(-1);
  if (!d.can_do) {
    return `<div class="card draft" data-id="${d.id}"><h3>Can't do this one</h3><p class="sentence">“${esc(d.sentence)}”</p><p>${esc(d.cannot_reason)}</p><div class="row"><button data-act="discard">OK</button></div></div>`;
  }
  return `<div class="card draft" data-id="${d.id}">
    <h3>${esc(d.title)}</h3>
    <p class="sentence">“${esc(d.sentence)}”${d.from ? ` <span class="badge">from ${esc(d.from)}</span>` : ""}</p>
    <p>${esc(d.summary)}</p>
    ${slip(d)}
    <ol class="steps">${d.steps.map((s) => `<li>${stepText(s, d.model)}</li>`).join("")}</ol>
    ${last ? resultHtml(last, true) + matchesHtml(last, true) : `<p class="hint">No practice run yet${d.sites.length ? " — Firefox will ask before it can read " + d.sites.map(host).join(", ") : ""}.</p>`}
    ${last ? `<details><summary>What each step did</summary>${stepsLog(last)}</details>` : ""}
    <div class="row">
      <button class="primary" data-act="approve">Approve and start</button>
      <button data-act="practice">Practice run</button>
      <button class="ghost" data-act="discard">Discard</button>
    </div>
  </div>`;
}

function orderCard(o: Order) {
  const runs = state!.log.filter((r) => r.orderId === o.id && r.why !== "practice");
  const last = runs.at(-1);
  // Show the latest list of matches, even if the latest run had nothing new or failed.
  const withMatches = [...runs].reverse().find((r) => r.matches?.length);
  const status = o.paused ? "Paused" : last ? `Last ran ${ago(last.at)}` : o.trigger.kind === "manual" ? "Waiting for you to run it" : "Waiting for its first run";
  const short = o.paused ? "paused" : withMatches?.matches?.length ? `${withMatches.matches.length} match${withMatches.matches.length === 1 ? "" : "es"}${withMatches.matches.some((m) => m.new) ? ", some new" : ""}` : last?.error ? "needs attention" : last ? "nothing found" : "not run yet";
  return `<div class="card${collapsed.has(o.id) ? " collapsed" : ""}" data-id="${o.id}">
    <h3 class="toggle" title="Show or hide details"><span class="chev">▾</span>${esc(o.title)}<span class="short meta"> · ${esc(short)}</span>${o.repairs ? `<span class="badge" title="Steps the AI rewrote after the site changed">repaired ${o.repairs}×</span>` : ""}${o.from ? `<span class="badge">shared</span>` : ""}</h3>
    <div class="body">
    <p class="meta">${esc(status)} · ${esc(whenText(o.trigger))}</p>
    ${last ? resultHtml(last, false) : ""}
    ${withMatches ? matchesHtml(withMatches, false) + (withMatches !== last ? `<p class="meta">From ${ago(withMatches.at)}</p>` : "") : ""}
    <details><summary>Details and history (${runs.length} run${runs.length === 1 ? "" : "s"})</summary>
      <p class="sentence">“${esc(o.sentence)}”</p>
      ${slip(o)}
      <ol class="steps">${o.steps.map((s) => `<li>${stepText(s, o.model)}</li>`).join("")}</ol>
      <ul>${runs.slice(-10).reverse().map((r) => `<li class="${r.ok ? "" : "bad"}">${new Date(r.at).toLocaleString()} — ${r.error ? esc(r.error) : `found ${r.found}, told ${r.told.length}`}${r.repaired ? " (repaired)" : ""}</li>`).join("")}</ul>
    </details>
    <div class="row">
      <button data-act="run"${o.trigger.kind === "on_visit" ? ' title="Runs on the page you have open, if it matches"' : ""}>Run now</button>
      <button data-act="pause">${o.paused ? "Resume" : "Pause"}</button>
      <button data-act="share">Share</button>
      <button class="ghost danger" data-act="cancel">Cancel order</button>
    </div>
    </div>
  </div>`;
}

async function refresh() {
  state = await call({ type: "state" });
  $("page-host").textContent = state!.page ? `(${host(state!.page)})` : "(no page open)";
  $("drafts").innerHTML = state!.drafts.map(draftCard).join("");
  $("orders").innerHTML = state!.orders.length ? state!.orders.map(orderCard).join("") : '<p class="hint">None yet. Give one above.</p>';
  $("key-state").textContent = state!.settings.apiKey ? "A key is saved. Leave blank to keep it." : "No key saved.";
  $<HTMLSelectElement>("writer").value = state!.settings.writer;
  $<HTMLInputElement>("local-model").value = state!.settings.localModel;
}

// A download link doesn't work from an extension sidebar, so files go through Firefox's
// downloads feature, into the person's usual downloads folder.
async function saveFile(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  try {
    const id = await browser.downloads.download({ url, filename: name, saveAs: false, conflictAction: "uniquify" });
    // Keep the blob alive until Firefox has written the file.
    await new Promise<void>((resolve) => {
      const done = (d: browser.downloads._OnChangedDownloadDelta) => { if (d.id === id && d.state?.current && d.state.current !== "in_progress") { browser.downloads.onChanged.removeListener(done); resolve(); } };
      browser.downloads.onChanged.addListener(done);
      setTimeout(resolve, 10_000);
    });
  } finally { URL.revokeObjectURL(url); }
}

// ---------- actions ----------
$("draft").addEventListener("click", () => {
  const sentence = $<HTMLTextAreaElement>("sentence").value.trim();
  if (!sentence || busy) return;
  const usePage = $<HTMLInputElement>("use-page").checked;
  const page = state?.page ?? "";
  // Must be the first thing in the click handler: Firefox only shows its
  // permission prompt while handling the click itself.
  const asked = usePage && page ? browser.permissions.request({ origins: [pattern(origin(page))] }) : Promise.resolve(true);
  (async () => {
    if (!(await asked)) { setStatus(`It can't read ${host(page)} without your OK.`, "error"); return; }
    busy = "draft";
    $<HTMLButtonElement>("draft").disabled = true;
    setStatus("Writing the order and trying it out…", "busy");
    try {
      const d = await call<Order>({ type: "draft", sentence, usePage, layoutOnly: usePage && $<HTMLInputElement>("layout-only").checked });
      setStatus(d.can_do ? "Here's the draft. Nothing runs until you approve it." : "");
      $<HTMLTextAreaElement>("sentence").value = "";
    } catch (e) { setStatus((e as Error).message, "error"); }
    finally { busy = ""; $<HTMLButtonElement>("draft").disabled = false; await refresh(); }
  })();
});

document.body.addEventListener("click", (ev) => {
  const head = (ev.target as HTMLElement).closest("#orders h3.toggle");
  if (head && !(ev.target as HTMLElement).closest("a, button")) {
    const card = head.closest<HTMLElement>("[data-id]")!;
    const id = card.dataset.id!;
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    card.classList.toggle("collapsed", collapsed.has(id));
    localStorage.setItem("collapsed", JSON.stringify([...collapsed]));
    return;
  }
  const btn = (ev.target as HTMLElement).closest("button[data-act]") as HTMLButtonElement | null;
  if (!btn) return;
  const id = btn.closest<HTMLElement>("[data-id]")!.dataset.id!;
  const act = btn.dataset.act!;
  const all = [...(state?.drafts ?? []), ...(state?.orders ?? [])];
  const o = all.find((x) => x.id === id);
  if (!o) return;
  if (act === "approve") {
    const practiced = state!.log.filter((r) => r.orderId === id).at(-1);
    if (practiced && !practiced.ok && !confirm(`The practice run didn't work: ${practiced.error ?? practiced.steps.find((x) => !x.ok)?.note ?? "it found nothing"}.\n\nApprove anyway?`)) return;
  }
  // Approving asks Firefox for exactly the order's sites — first thing in the click.
  const asked = act === "approve" || act === "practice" || act === "run"
    ? (o.sites.length ? browser.permissions.request({ origins: o.sites.map((s) => pattern(origin(s))) }) : Promise.resolve(true))
    : Promise.resolve(true);
  (async () => {
    if (!(await asked)) { setStatus("Not started: Firefox access to its sites was declined.", "error"); return; }
    btn.disabled = true;
    try {
      if (act === "share") {
        const file = await call<OrderFile>({ type: "share", id });
        const name = `${o.title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}.marching-order.json`;
        await saveFile(name, file);
        setStatus(`Saved ${name} to your downloads. Send it to a friend; they load it with “Import an order…”.`);
      } else if (act === "cancel") {
        if (!confirm(`Cancel “${o.title}”? It stops running and is removed.`)) return;
        await call({ type: "cancel", id });
      } else if (act === "pause") {
        await call({ type: "pause", id, paused: !o.paused });
      } else {
        if (act === "run" || act === "practice") { setStatus(act === "run" ? "Running…" : "Practice run…", "busy"); busy = act; }
        try { await call({ type: act, id }); } finally { if (busy === act) busy = ""; }
        setStatus(act === "approve" ? "Approved. It runs on its own from now on." : "");
      }
    } catch (e) { setStatus((e as Error).message, "error"); }
    finally { btn.disabled = false; await refresh(); }
  })();
});

$<HTMLInputElement>("import").addEventListener("change", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    await call({ type: "import", file: JSON.parse(await file.text()) });
    setStatus("Imported. Check what it may touch, then practice or approve it.");
  } catch (e) { setStatus(e instanceof SyntaxError ? "That file isn't an order." : (e as Error).message, "error"); }
  (ev.target as HTMLInputElement).value = "";
  await refresh();
});

$("settings-toggle").addEventListener("click", () => { $("settings").hidden = !$("settings").hidden; });
$("save-settings").addEventListener("click", async () => {
  const key = $<HTMLInputElement>("api-key").value.trim();
  await call({ type: "settings", settings: { writer: $<HTMLSelectElement>("writer").value, localModel: $<HTMLInputElement>("local-model").value.trim() || "qwen3:14b", ...(key ? { apiKey: key } : {}) } });
  $<HTMLInputElement>("api-key").value = "";
  setStatus("Settings saved.");
});
$("export-study").addEventListener("click", async () => {
  const data = await call({ type: "export-study" });
  const name = `marching-orders-study-${new Date().toISOString().slice(0, 10)}.json`;
  try { await saveFile(name, data); setStatus(`Saved ${name} to your downloads.`); }
  catch (e) { setStatus((e as Error).message, "error"); }
});

browser.runtime.onMessage.addListener((m: { type: string; text?: string }) => {
  if (m.type === "progress" && busy) setStatus(m.text ?? "", "busy");
  if (m.type === "changed" && !busy) refresh();
});
browser.tabs.onActivated.addListener(() => setTimeout(refresh, 100));
browser.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") setTimeout(refresh, 100); });
refresh();
