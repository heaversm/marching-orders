// The host. Holds orders, wakes them on a schedule or a page visit, carries
// out their steps with fixed code, and keeps a log of every run. Models are
// called only to write an order, repair a broken step, or answer a judge /
// summarize step — and every call is counted in the log.
import { DEFAULT_SETTINGS, judge, repairStep, Settings, summarize, writeOrder } from "./model";
import { Condition, Draft, Measure, Order, OrderFile, origin, pattern, RunRecord, Step, StepNote, usesModel } from "./order";
import { clickLabel, collectItems, outlinePage, pageState, restyle, waitForQuiet } from "./page";
import { normalize } from "./normalize";
import { datedUrl } from "./urls";

const OUTLINE_CHARS = 40_000;
const LOG_KEEP = 500;

// ---------- storage ----------
async function getOrders(): Promise<Order[]> { return ((await browser.storage.local.get("orders")).orders as Order[]) ?? []; }
async function saveOrders(orders: Order[]) { await browser.storage.local.set({ orders }); }
async function getOrder(id: string) { return (await getOrders()).find((o) => o.id === id); }
async function putOrder(order: Order) {
  const orders = await getOrders();
  const i = orders.findIndex((o) => o.id === order.id);
  if (i >= 0) orders[i] = order; else orders.push(order);
  await saveOrders(orders);
}
async function getSettings(): Promise<Settings> { return { ...DEFAULT_SETTINGS, ...((await browser.storage.local.get("settings")).settings as Partial<Settings>) }; }
async function getLog(): Promise<RunRecord[]> { return ((await browser.storage.local.get("log")).log as RunRecord[]) ?? []; }
async function addLog(r: RunRecord) {
  const log = await getLog();
  log.push(r);
  await browser.storage.local.set({ log: log.slice(-LOG_KEEP) });
  broadcast();
}
async function getSeen(id: string): Promise<string[]> { return ((await browser.storage.local.get(`seen:${id}`))[`seen:${id}`] as string[]) ?? []; }
async function setSeen(id: string, keys: string[]) { await browser.storage.local.set({ [`seen:${id}`]: keys.slice(-2000) }); }
/** Drafts waiting for approval, keyed by id. Kept in storage so a sidebar reload doesn't lose them. */
async function getDrafts(): Promise<Order[]> { return ((await browser.storage.local.get("drafts")).drafts as Order[]) ?? []; }
async function setDrafts(d: Order[]) { await browser.storage.local.set({ drafts: d }); broadcast(); }

/** Every event the study needs, in one list: drafts, approvals, runs, repairs, shares. */
async function event(kind: string, detail: Record<string, unknown>) {
  const events = ((await browser.storage.local.get("events")).events as unknown[]) ?? [];
  events.push({ kind, at: Date.now(), ...detail });
  await browser.storage.local.set({ events: events.slice(-2000) });
}

const broadcast = () => browser.runtime.sendMessage({ type: "changed" }).catch(() => {});
const uid = () => crypto.randomUUID().slice(0, 8);
const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

// ---------- the page the person is looking at ----------
// The sidebar asks for "this page". In a real sidebar that's the active tab;
// in tests the sidebar is itself a tab, so remember the last web page that was active.
let lastWebTab: { id: number; url: string } | null = null;
const isWeb = (u?: string) => !!u && /^https?:/.test(u);
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const t = await browser.tabs.get(tabId).catch(() => null);
  if (t && isWeb(t.url) && !t.hidden) lastWebTab = { id: tabId, url: t.url! };
});
browser.tabs.onRemoved.addListener((tabId) => { if (lastWebTab?.id === tabId) lastWebTab = null; });
/** The web page the person is on: the active tab if it's a web page, else the last one that was. */
async function currentWebTab(): Promise<{ id: number; url: string } | null> {
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== undefined && isWeb(active.url) && !active.hidden) return (lastWebTab = { id: active.id, url: active.url! });
  if (!lastWebTab) return null;
  const t = await browser.tabs.get(lastWebTab.id).catch(() => null);
  if (!t || !isWeb(t.url)) return (lastWebTab = null);
  return (lastWebTab = { id: t.id!, url: t.url! });
}

// ---------- hidden tabs ----------
async function openHidden(url: string): Promise<number> {
  const tab = await browser.tabs.create({ url, active: false });
  await browser.tabs.hide(tab.id!).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    const cap = setTimeout(() => { browser.tabs.onUpdated.removeListener(l); reject(new Error(`Timed out loading ${url}`)); }, 30_000);
    const l = (id: number, info: browser.tabs._OnUpdatedChangeInfo) => {
      if (id === tab.id && info.status === "complete") { clearTimeout(cap); browser.tabs.onUpdated.removeListener(l); resolve(); }
    };
    browser.tabs.onUpdated.addListener(l);
  });
  await inTab(tab.id!, waitForQuiet, [800, 8000]);
  return tab.id!;
}

/** Reject if `p` takes longer than `ms`, naming what was slow. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s ${what}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
/** Tell an open sidebar what's happening, so a slow step doesn't look like a hang. */
const progress = (text: string) => browser.runtime.sendMessage({ type: "progress", text }).catch(() => {});

async function inTab<A extends unknown[], R>(tabId: number, func: (...args: A) => R, args: A): Promise<Awaited<R>> {
  const [res] = await within(browser.scripting.executeScript({ target: { tabId }, func: func as never, args: args as never }), 30_000, `waiting for the page to answer (${func.name})`);
  if ((res as { error?: unknown }).error) throw new Error(String((res as { error?: unknown }).error));
  return res.result as Awaited<R>;
}

async function outlineOf(tabId: number, layoutOnly = false) {
  const tab = await browser.tabs.get(tabId);
  // In layout-only mode the writer gets a masked URL too (paths can carry account numbers).
  const url = tab.url ?? "";
  const shown = layoutOnly && url ? origin(url) + new URL(url).pathname.replace(/[A-Z]/g, "X").replace(/[a-z]/g, "x").replace(/[0-9]/g, "9") : url;
  return { url: shown, outline: await inTab(tabId, outlinePage, [OUTLINE_CHARS, layoutOnly]) };
}

// ---------- carrying out an order ----------
const num = (s: string) => {
  const m = (s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
function passes(value: string, test: string, target: string) {
  const v = (value ?? "").toLowerCase(), t = target.toLowerCase();
  switch (test) {
    case "less_than": return num(value) < num(target);
    case "more_than": return num(value) > num(target);
    case "at_most": return num(value) <= num(target);
    case "at_least": return num(value) >= num(target);
    case "between": {
      const [lo, hi] = target.split("..").map(num);
      return num(value) >= lo && num(value) <= hi;
    }
    case "contains": return v.includes(t);
    case "not_contains": return !v.includes(t);
    case "equals": return v.trim() === t.trim();
  }
  return false;
}
const passesAll = (it: Record<string, string>, conds: Condition[]) => conds.every((c) => passes(it[c.field], c.test, c.value));

/** "7 hr 25 min" -> 7.42; "1h 5m" -> 1.08; "95 min" -> 1.58 */
function hours(s: string) {
  const h = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i.exec(s ?? "");
  const m = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/i.exec(s ?? "");
  if (!h && !m) return NaN;
  return Math.round(((h ? parseFloat(h[1]) : 0) + (m ? parseInt(m[1]) / 60 : 0)) * 100) / 100;
}
/** "3:30 pm" -> 15.5; "7 AM" -> 7; "15:30" -> 15.5; "12 am" -> 0 */
function timeOfDay(s: string) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(s ?? "");
  if (!m) return NaN;
  let h = parseInt(m[1]) % 24;
  const ap = (m[3] ?? "").toLowerCase().replace(/\./g, "");
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return Math.round((h + (m[2] ? parseInt(m[2]) / 60 : 0)) * 100) / 100;
}
const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "");
export function compute(how: string, vals: string[]) {
  switch (how) {
    case "percent_off": {
      const [now, was] = vals.map(num);
      return Number.isFinite(now) && Number.isFinite(was) && was > 0 ? fmt(Math.round(((was - now) / was) * 100)) : "0";
    }
    case "minus": return fmt(num(vals[0]) - num(vals[1]));
    case "number": return fmt(num(vals[0]));
    case "hours": return fmt(hours(vals[0]));
    case "time_of_day": return fmt(timeOfDay(vals[0]));
    case "days_between": return fmt(daysBetween(vals.join(" ")));
    case "dates": {
      const m = [...vals.join(" ").matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi)].slice(0, 2).map((x) => `${x[1][0].toUpperCase()}${x[1].slice(1, 3).toLowerCase()} ${x[2]}`);
      return m.join("–");
    }
  }
  return "";
}
/** "Dec 7 to Dec 11" -> 4; "Dec 28 – Jan 2" -> 5; "12/7 to 12/11" -> 4 */
export function daysBetween(s: string) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const found: [number, number][] = [];
  for (const m of (s ?? "").matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/gi)) found.push([months.indexOf(m[1].toLowerCase()), parseInt(m[2])]);
  if (found.length < 2) for (const m of (s ?? "").matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) found.push([parseInt(m[1]) - 1, parseInt(m[2])]);
  if (found.length < 2) return NaN;
  const y = 2001; // any non-leap year; a wrap past December adds a year
  const a = Date.UTC(y, found[0][0], found[0][1]);
  let b = Date.UTC(y, found[1][0], found[1][1]);
  if (b < a) b = Date.UTC(y + 1, found[1][0], found[1][1]);
  return Math.round((b - a) / 864e5);
}
function measure(m: Measure, items: Record<string, string>[]) {
  const pool = items.filter((it) => passesAll(it, m.where));
  const nums = pool.map((it) => num(it[m.field])).filter(Number.isFinite);
  switch (m.measure) {
    case "count": return pool.length;
    case "sum": return nums.reduce((a, b) => a + b, 0);
    case "max": return nums.length ? Math.max(...nums) : NaN;
    case "min": return nums.length ? Math.min(...nums) : NaN;
  }
}
const describeMeasure = (m: Measure, v: number) => `${m.measure}${m.measure === "count" ? "" : " of " + m.field}${m.where.length ? " where " + m.where.map((c) => `${c.field} ${c.test} ${c.value}`).join(" and ") : ""} = ${fmt(v)}`;
const fill = (line: string, item: Record<string, string>, items: Record<string, string>[] = []) =>
  line.replace(/\{(?:(sum|max|min):)?(\w+)\}/g, (_, agg: string | undefined, k: string) => {
    if (!agg && k === "count") return String(items.length);
    if (agg) return fmt(measure({ measure: agg as Measure["measure"], field: k, where: [], test: "equals", value: "" }, items));
    return item[k] ?? "";
  });
/** Read a collect step's items, waiting up to 15 s for a list that is drawn late. */
async function pollCollect(tabId: number, step: Extract<Step, { do: "collect" }>) {
  let res = await inTab(tabId, collectItems, [step.items, step.fields]);
  for (let waited = 0; res.rows.length === 0 && !res.error && waited < 15; waited++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await inTab(tabId, collectItems, [step.items, step.fields]);
  }
  return res;
}
const allowed = (order: Draft, url: string) => order.sites.some((s) => origin(s) === origin(url));

export async function runOrder(order: Order, why: RunRecord["why"], visitTab?: number): Promise<RunRecord> {
  const t0 = Date.now();
  const settings = await getSettings();
  const rec: RunRecord = { orderId: order.id, version: order.version, at: t0, why, ok: true, steps: [], found: 0, kept: 0, told: [], modelCalls: { local: 0, cloud: 0 }, repaired: false, ms: 0, warnings: [] };
  const note = (s: Step, n: string, ok = true) => rec.steps.push({ do: s.do, note: n, ok });
  const practice = why === "practice";
  let tabId = visitTab;
  let hidden: number | undefined;
  let items: Record<string, string>[] = [];
  let key = "";
  // What passes the filters before "only new" drops the ones already reported, for the Matches list.
  let pool: Record<string, string>[] | null = null;
  let freshIds: Set<string> | null = null;
  // Private-page orders never send page items to the cloud, whatever the order file says.
  const where = order.model === "cloud" && !order.layoutOnly ? "cloud" : "local";
  try {
    for (let i = 0; i < order.steps.length; i++) {
      const step = order.steps[i];
      switch (step.do) {
        case "open": {
          if (visitTab !== undefined) { note(step, "Skipped: already on the page"); break; }
          // The slip: the order may only open its own sites, and Firefox must have granted them.
          const url = datedUrl(step.url);
          if (!allowed(order, url)) throw new Error(`Blocked: ${origin(url)} isn't one of this order's sites`);
          if (!(await browser.permissions.contains({ origins: [pattern(origin(url))] }))) throw new Error(`Firefox hasn't granted access to ${origin(url)}`);
          if (hidden !== undefined) await browser.tabs.remove(hidden).catch(() => {});
          if (practice) progress(`Practice run: opening ${host(url)} in a hidden tab…`);
          hidden = tabId = await openHidden(url);
          note(step, `Opened ${url} in a hidden tab`);
          break;
        }
        case "read_also": {
          // Repeat the clicks and the collect since the last open, on each further URL.
          const openAt = order.steps.slice(0, i).map((x) => x.do).lastIndexOf("open");
          const segment = order.steps.slice(openAt + 1, i).filter((x) => x.do === "click" || x.do === "collect");
          const last = [...segment].reverse().find((x): x is Extract<Step, { do: "collect" }> => x.do === "collect");
          if (!last) throw new Error("read_also needs a collect step before it");
          const seenKeys = new Set(items.map((it) => it[last.key]).filter(Boolean));
          let added = 0;
          for (const [n, raw] of step.urls.slice(0, 10).entries()) {
            const url = datedUrl(raw);
            if (!allowed(order, url)) throw new Error(`Blocked: ${origin(url)} isn't one of this order's sites`);
            if (!(await browser.permissions.contains({ origins: [pattern(origin(url))] }))) throw new Error(`Firefox hasn't granted access to ${origin(url)}`);
            if (practice) progress(`Practice run: search ${n + 2} of ${step.urls.length + 1}…`);
            if (hidden !== undefined) await browser.tabs.remove(hidden).catch(() => {});
            hidden = tabId = await openHidden(url);
            for (const seg of segment) {
              if (seg.do === "click") {
                const r = await inTab(tabId, clickLabel, [seg.label]);
                if (!r.clicked) throw new Error(r.why);
                await inTab(tabId, waitForQuiet, [800, 8000]);
              } else if (seg.do === "collect") {
                const res = await pollCollect(tabId, seg);
                if (seg !== last) continue;
                for (const row of res.rows) {
                  const k = row[last.key];
                  if (k && seenKeys.has(k)) continue;
                  if (k) seenKeys.add(k);
                  items.push(row);
                  added++;
                }
              }
            }
          }
          rec.found = items.length;
          note(step, `Read ${step.urls.length} more page${step.urls.length === 1 ? "" : "s"}; ${added} more items (${items.length} in all)`);
          break;
        }
        case "collect": {
          if (tabId === undefined) throw new Error("Nothing to read: no page is open");
          key = step.key;
          if (practice) progress("Practice run: reading items on the page…");
          let res = await inTab(tabId, collectItems, [step.items, step.fields]);
          const empty = (rows: Record<string, string>[]) => rows.length === 0 || rows.every((r) => !r[step.key]);
          // Firefox slows background tabs, and many sites draw their lists with JavaScript after
          // loading. If nothing is there yet, keep looking for up to 15 s before calling it empty.
          let waited = 0;
          while (res.rows.length === 0 && !res.error && waited < 15) {
            await new Promise((r) => setTimeout(r, 1000));
            waited++;
            res = await inTab(tabId, collectItems, [step.items, step.fields]);
          }
          if (waited && res.rows.length) note(step, `The list appeared after ${waited} s`);
          if (empty(res.rows)) {
            // Before blaming the order: is the site asking for a login, or blocking the hidden tab?
            const st = await inTab(tabId, pageState, []);
            if (st.login) throw new Error("The site wants you to log in again. Log in in a normal tab, then this order works again.");
            if (st.blocked) throw new Error(`The site blocked the check (“${st.blocked}”). Open it in a normal tab once, then try again.`);
          }
          if (empty(res.rows) && !practice) {
            // The site may have changed. Ask the writer once for a new version of this step.
            const page = await outlineOf(tabId, !!order.layoutOnly);
            const problem = res.error || `It found ${res.rows.length} items${res.rows.length ? " but none had a " + step.key : ""}.`;
            const fix = await repairStep(settings, order.sentence, step, problem, page);
            rec.modelCalls[settings.writer]++;
            if (fix.value.step.do === "collect") {
              const retry = await inTab(tabId, collectItems, [fix.value.step.items, fix.value.step.fields]);
              if (!empty(retry.rows)) {
                res = retry;
                order.steps[i] = fix.value.step;
                order.version++;
                order.repairs++;
                rec.repaired = true;
                await putOrder(order);
                await event("repaired", { orderId: order.id, version: order.version, note: fix.value.note });
                note(step, `Repaired: ${fix.value.note}`);
              }
            }
          }
          // Pages often show the same item twice (a "best" list and a full list). Keep the first of each key.
          const seenKeys = new Set<string>();
          items = res.rows.filter((r) => { const k = r[step.key]; if (!k) return true; if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
          rec.found = items.length;
          const keyless = items.filter((it) => !it[step.key]).length;
          if (res.error || items.length === 0) {
            note(step, res.error || `Read 0 items (looked for “${step.items}”${waited ? ` for ${waited} s` : ""})`, false);
            rec.ok = false;
          } else if (keyless === items.length) {
            // "Only new" falls back to each item's full contents, so this still works; flag it so the writer gets another go.
            note(step, `Read ${items.length} items`);
            rec.warnings.push(`None of the items had a “${step.key}” value, so items are told apart by their full text instead.`);
          } else {
            note(step, `Read ${items.length} item${items.length === 1 ? "" : "s"}${keyless ? ` (${keyless} without a ${step.key})` : ""}`);
            for (const f of step.fields) if (items.every((it) => !it[f.name])) rec.warnings.push(`The “${f.name}” field was empty on every item (selector “${f.selector}”).`);
          }
          break;
        }
        case "keep": {
          const before = items.length;
          items = items.filter((it) => passes(it[step.field], step.test, step.value));
          note(step, `Kept ${items.length} of ${before} (${step.field} ${step.test} ${step.value})`);
          break;
        }
        case "keep_any": {
          const before = items.length;
          items = items.filter((it) => step.tests.some((c) => passes(it[c.field], c.test, c.value)));
          note(step, `Kept ${items.length} of ${before} (any of: ${step.tests.map((c) => `${c.field} ${c.test} ${c.value}`).join("; ")})`);
          break;
        }
        case "compute": {
          if (step.how === "day") {
            // Sequence-aware: count how many times the clock wraps past midnight down the list.
            let day = 0, prev = -1;
            items = items.map((it) => {
              const h = timeOfDay(it[step.from[0]] ?? "");
              if (Number.isFinite(h)) { if (prev >= 0 && h < prev) day++; prev = h; }
              return { ...it, [step.name]: String(day) };
            });
          } else items = items.map((it) => ({ ...it, [step.name]: compute(step.how, step.from.map((f) => it[f] ?? "")) }));
          const blank = items.filter((it) => !it[step.name]).length;
          note(step, `Worked out ${step.name} (${step.how})${blank ? `; blank on ${blank} of ${items.length}` : ""}`);
          if (items.length && blank === items.length) rec.warnings.push(`Couldn't work out “${step.name}” for any item.`);
          break;
        }
        case "judge": {
          const kept: Record<string, string>[] = [];
          const ask = items.slice(0, 25);
          for (const [n, it] of ask.entries()) {
            if (practice) progress(`Practice run: asking the ${where} model about ${n + 1} of ${ask.length}…`);
            const v = await judge(settings, where, step.question, it);
            rec.modelCalls[where]++;
            if (v.answer === "yes") kept.push(it);
          }
          note(step, `Asked the ${where} model about ${Math.min(items.length, 25)}; kept ${kept.length}`);
          items = kept;
          break;
        }
        case "only_new": {
          const seen = new Set(await getSeen(order.id));
          const idField = step.field || key;
          const idOf = (it: Record<string, string>) => it[idField] || JSON.stringify(it);
          // Also drop repeats within this run (the same item read twice while paging).
          const once = new Set<string>();
          items = items.filter((it) => { const k = idOf(it); if (once.has(k)) return false; once.add(k); return true; });
          const fresh = items.filter((it) => !seen.has(idOf(it)));
          pool = items;
          freshIds = new Set(fresh.map(idOf));
          key = idField;
          note(step, `${fresh.length} new of ${items.length}`);
          if (!practice) await setSeen(order.id, [...seen, ...fresh.map(idOf)]);
          items = fresh;
          break;
        }
        case "summarize": {
          if (items.length) {
            const text = await summarize(settings, where, step.instruction, items);
            rec.modelCalls[where]++;
            items = [{ summary: text, ...Object.fromEntries([["count", String(items.length)]]) }];
            note(step, text);
          } else note(step, "Nothing to summarize");
          break;
        }
        case "notify": {
          rec.kept = items.length;
          if (!items.length) { note(step, "Nothing to report"); break; }
          if (step.only_if?.length) {
            const results = step.only_if.map((m) => { const v = measure(m, items); return { m, v, pass: passes(fmt(v), m.test, m.value) }; });
            const passed = results.filter((r) => r.pass);
            note(step, `Checks: ${results.map((r) => `${describeMeasure(r.m, r.v)} ${r.pass ? "✓" : "✗"}`).join("; ")}`);
            if (!passed.length) { rec.kept = 0; note(step, "No check passed, so nothing to report"); break; }
          }
          const lines = items.map((it) => fill(step.line, it, items));
          const title = fill(step.title, {}, items);
          const missing = [...step.line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => k !== "count" && items.every((it) => !it[k]));
          if (missing.length) rec.warnings.push(`The notification uses ${missing.map((k) => `{${k}}`).join(", ")}, which no item has.`);
          rec.told = lines;
          if (!practice) {
            const opened = order.steps.find((x): x is Extract<Step, { do: "open" }> => x.do === "open")?.url;
            const isUrl = (v?: string) => !!v && /^https?:\/\//.test(v);
            const itemLink = (it: Record<string, string>) => (isUrl(it[key]) ? it[key] : Object.values(it).find(isUrl));
            const nid = `mo:${order.id}:${Date.now()}`;
            // One thing: open it. Several: show the list in the sidebar (or the page that was checked).
            notificationTargets.set(nid, { one: items.length === 1 ? itemLink(items[0]) ?? opened : undefined, page: opened ?? (visitTab !== undefined ? (await browser.tabs.get(visitTab)).url : undefined) });
            await browser.notifications.create(nid, {
              type: "basic", iconUrl: "icons/icon-48.png", title,
              message: lines.slice(0, 4).join("\n") + (lines.length > 4 ? `\n…and ${lines.length - 4} more` : "") + (items.length > 1 ? "\nClick to see them all, with links." : "\nClick to open it."),
            });
          }
          note(step, `${practice ? "Would tell you" : "Told you"} about ${lines.length}`);
          break;
        }
        case "click": {
          if (tabId === undefined) throw new Error("Nothing to click: no page is open");
          const before = (await browser.tabs.get(tabId)).url ?? "";
          if (practice) progress(`Practice run: clicking “${step.label}”…`);
          const r = await inTab(tabId, clickLabel, [step.label]);
          if (!r.clicked) throw new Error(r.why);
          await inTab(tabId, waitForQuiet, [800, 8000]);
          const after = (await browser.tabs.get(tabId)).url ?? "";
          if (origin(after) !== origin(before)) throw new Error(`Stopped: clicking “${r.why}” went to another site`);
          note(step, `Clicked “${r.why}”`);
          break;
        }
        case "page_through": {
          if (tabId === undefined) throw new Error("Nothing to page through: no page is open");
          const last = order.steps.slice(0, i).reverse().find((x): x is Extract<Step, { do: "collect" }> => x.do === "collect");
          if (!last) throw new Error("page_through needs a collect step before it");
          const seenKeys = new Set(items.map((it) => it[last.key]).filter(Boolean));
          const base = order.steps.find((x): x is Extract<Step, { do: "open" }> => x.do === "open")?.url ?? "";
          let clicks = 0, added = 0;
          const labels = step.labels?.length ? step.labels : [(step as unknown as { label: string }).label];
          rounds: for (let n = 0; n < Math.min(40, Math.max(0, step.times)); n++) {
            if (practice) progress(`Practice run: clicking ${labels.map((l) => `“${l}”`).join(" and ")} (${n + 1} of ${step.times})…`);
            for (const label of labels) {
              const r = await inTab(tabId, clickLabel, [label]);
              if (!r.clicked) { if (clicks === 0) throw new Error(r.why); break rounds; }
              await inTab(tabId, waitForQuiet, [500, 6000]);
              if (base && origin((await browser.tabs.get(tabId)).url ?? "") !== origin(base)) throw new Error(`Stopped: clicking “${r.why}” went to another site`);
            }
            clicks++;
            const more = await inTab(tabId, collectItems, [last.items, last.fields]);
            for (const row of more.rows) {
              const k = row[last.key];
              if (k && seenKeys.has(k)) continue;
              if (k) seenKeys.add(k);
              items.push(row);
              added++;
            }
          }
          rec.found = items.length;
          note(step, `Clicked ${labels.map((l) => `“${l}”`).join(" and ")} ${clicks} time${clicks === 1 ? "" : "s"}; ${added} more items (${items.length} in all)`);
          break;
        }
        case "hide":
        case "highlight": {
          if (tabId === undefined) throw new Error("No page to change");
          if (practice && visitTab === undefined) { note(step, `Would ${step.do} matching parts of the page`); break; }
          const n = await inTab(tabId, restyle, [step.selector, step.do]);
          note(step, n < 0 ? `Bad selector: ${step.selector}` : `${step.do === "hide" ? "Hid" : "Highlighted"} ${n}`, n > 0);
          break;
        }
      }
    }
    if (!order.steps.some((s) => s.do === "notify")) rec.kept = items.length;
  } catch (e) {
    rec.ok = false;
    rec.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (hidden !== undefined) await browser.tabs.remove(hidden).catch(() => {});
  }
  if (practice) rec.items = items.slice(0, 20);
  {
    const shown = pool ?? (rec.ok ? items : []);
    const tmpl = order.steps.find((x): x is Extract<Step, { do: "notify" }> => x.do === "notify")?.line;
    const opened = order.steps.find((x): x is Extract<Step, { do: "open" }> => x.do === "open")?.url ?? "";
    const isUrl = (v?: string) => !!v && /^https?:\/\//.test(v);
    const linkOf = (it: Record<string, string>) => (isUrl(it[key]) ? it[key] : Object.values(it).find(isUrl) ?? opened);
    const idOf = (it: Record<string, string>) => it[key] || JSON.stringify(it);
    const label = (it: Record<string, string>) => (tmpl ? fill(tmpl, it, shown) : Object.values(it).filter((v) => !isUrl(v)).slice(0, 3).join(" — ")).trim();
    rec.matches = shown.slice(0, 30).map((it) => ({ line: label(it) || linkOf(it), url: linkOf(it), new: freshIds ? freshIds.has(idOf(it)) : true }));
  }
  rec.ms = Date.now() - t0;
  await addLog(rec);
  return rec;
}

// Clicking a notification: one item opens that item; several open the sidebar, where
// the order's card lists them all with links. If Firefox won't open the sidebar from a
// notification, open the page that was checked instead.
const notificationTargets = new Map<string, { one?: string; page?: string }>();
browser.notifications.onClicked.addListener((nid) => {
  const t = notificationTargets.get(nid);
  if (!t) return;
  if (t.one) { browser.tabs.create({ url: t.one }); return; }
  browser.sidebarAction.open().catch(() => { if (t.page) browser.tabs.create({ url: t.page }); });
});

// ---------- triggers ----------
/** Next time today or tomorrow at "HH:MM" local time. */
export function nextAt(at: string, now = new Date()) {
  const [h, m] = at.split(":").map((x) => parseInt(x));
  const t = new Date(now);
  t.setHours(h || 0, m || 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}
async function schedule(order: Order) {
  await browser.alarms.clear(`order:${order.id}`);
  if (!order.approved || order.paused) return;
  if (order.trigger.kind === "every") {
    browser.alarms.create(`order:${order.id}`, { periodInMinutes: Math.max(1, order.trigger.minutes), delayInMinutes: Math.max(1, order.trigger.minutes) });
  } else if (order.trigger.kind === "daily") {
    browser.alarms.create(`order:${order.id}`, { when: nextAt(order.trigger.at), periodInMinutes: 1440 });
  }
}
browser.alarms.onAlarm.addListener(async (a) => {
  if (!a.name.startsWith("order:")) return;
  const order = await getOrder(a.name.slice(6));
  if (order && order.approved && !order.paused) await runOrder(order, "schedule");
});
browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url && tabId === lastWebTab?.id && !isWeb(info.url)) lastWebTab = null;
  if (info.status !== "complete" || !isWeb(tab.url)) return;
  if (!tab.hidden && tab.active) lastWebTab = { id: tabId, url: tab.url! };
  if (tab.hidden) return; // our own hidden tabs
  for (const order of await getOrders()) {
    if (order.approved && !order.paused && order.trigger.kind === "on_visit" && tab.url!.startsWith(order.trigger.match) && allowed(order, tab.url!)) {
      await runOrder(order, "visit", tabId);
    }
  }
});

// ---------- making drafts ----------
async function draftFrom(sentence: string, usePage: boolean, layoutOnly = false, prior?: Draft): Promise<Order> {
  const settings = await getSettings();
  let page: { url: string; outline: string } | null = null;
  if (usePage) {
    const tab = await currentWebTab();
    if (!tab) throw new Error("No web page is open to use. Open the page first, or untick “Use this page”.");
    progress(layoutOnly ? "Reading this page's layout (text masked)…" : "Reading this page…");
    page = await outlineOf(tab.id, layoutOnly);
  }
  // The writer saw a masked URL; the order must open the real one.
  const realUrl = usePage ? (await currentWebTab())?.url : undefined;
  progress(settings.writer === "cloud" ? "Asking Claude to write the order…" : "Asking the local model to write the order (1–2 minutes)…");
  let draft = normalize(prior ?? (await writeOrder(settings, sentence, page)).value, sentence, realUrl);
  if (layoutOnly && realUrl) draft = unmaskUrls(draft, realUrl);
  if (layoutOnly && draft.model === "cloud") draft = { ...draft, model: "local" };
  const order: Order = { ...draft, id: uid(), sentence, createdAt: Date.now(), approved: false, paused: false, version: 1, repairs: 0, layoutOnly };
  return order;
}

/** In layout-only mode the writer saw "xxxxxxxx/xxxxxx" for the path; point open steps on that site at the real page. */
function unmaskUrls(d: Draft, realUrl: string): Draft {
  const o = origin(realUrl);
  const masked = (u: string) => /^[xX9\/._~%-]*$/.test(new URL(u, o).pathname.replace(/^\//, ""));
  return { ...d, steps: d.steps.map((s) => (s.do === "open" && origin(s.url) === o && masked(s.url) ? { ...s, url: realUrl } : s)) };
}

// ---------- messages from the sidebar ----------
type Msg =
  | { type: "state" }
  | { type: "page" }
  | { type: "draft"; sentence: string; usePage: boolean; layoutOnly?: boolean; replaces?: string }
  | { type: "practice"; id: string }
  | { type: "approve"; id: string }
  | { type: "discard"; id: string }
  | { type: "run"; id: string }
  | { type: "pause"; id: string; paused: boolean }
  | { type: "cancel"; id: string }
  | { type: "share"; id: string }
  | { type: "import"; file: OrderFile }
  | { type: "settings"; settings: Partial<Settings> }
  | { type: "export-study" };

async function practiceDraft(d: Order) {
  // A practice run never notifies or remembers what it saw. If it finds nothing,
  // give the writer one more try with what went wrong.
  const tab = d.trigger.kind === "on_visit" ? await currentWebTab() : null;
  const match = d.trigger.kind === "on_visit" ? d.trigger.match : "";
  return runOrder(d, "practice", tab && match && tab.url.startsWith(match) ? tab.id : undefined);
}

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case "state": {
      const [orders, drafts, log, settings] = await Promise.all([getOrders(), getDrafts(), getLog(), getSettings()]);
      return { orders, drafts, log: log.slice(-200), settings: { ...settings, apiKey: settings.apiKey ? "set" : "" }, page: (await currentWebTab())?.url ?? "" };
    }
    case "page": return (await currentWebTab())?.url ?? "";
    case "draft": {
      await event("draft-asked", { sentence: msg.sentence });
      const d = await draftFrom(msg.sentence, msg.usePage, !!msg.layoutOnly);
      if (msg.replaces && (await getOrder(msg.replaces))) d.replaces = msg.replaces;
      if (d.can_do) {
        // Practice right away so the person sees what it would do. One retry if it found nothing.
        const missing = d.sites.filter((s) => origin(s)).map((s) => pattern(origin(s)));
        const granted = missing.length ? await browser.permissions.contains({ origins: missing }) : true;
        if (granted) {
          const rec = await practiceDraft(d);
          const tab = msg.usePage ? await currentWebTab() : null;
          if ((!rec.ok || rec.warnings.length) && tab) {
            const settings = await getSettings();
            // Write the second draft from the page as the order will see it: opened fresh in a
            // hidden tab, without anything the person clicked (a selected tab, an open panel).
            const opens = d.steps.find((x): x is Extract<Step, { do: "open" }> => x.do === "open");
            let page: { url: string; outline: string };
            let fresh = false;
            if (opens && allowed(d, opens.url) && (await browser.permissions.contains({ origins: [pattern(origin(opens.url))] }))) {
              progress("The practice run went wrong; looking at the page as the order sees it…");
              const t = await openHidden(opens.url);
              try { page = await outlineOf(t, !!msg.layoutOnly); fresh = true; } finally { await browser.tabs.remove(t).catch(() => {}); }
            } else page = await outlineOf(tab.id, !!msg.layoutOnly);
            progress("Asking for a second draft…");
            const feedback = [
              rec.error, ...rec.steps.filter((s) => !s.ok).map((s) => `${s.do}: ${s.note}`), ...rec.warnings,
              fresh ? "The outline below is the page exactly as the order sees it when it opens the page fresh. The person's own tab may have looked different (something clicked or selected), so choose selectors from this outline." : "",
            ].filter(Boolean).join("; ");
            let second = normalize((await writeOrder(settings, msg.sentence, page, feedback)).value, msg.sentence, tab.url);
            if (msg.layoutOnly) second = { ...unmaskUrls(second, tab.url), model: second.model === "cloud" ? "local" : second.model };
            Object.assign(d, second);
            await event("redrafted", { id: d.id, feedback });
            await practiceDraft(d);
          }
        }
      }
      await event("drafted", { id: d.id, sentence: d.sentence, can_do: d.can_do, steps: d.steps.map((s) => s.do), trigger: d.trigger.kind, model: d.model });
      await setDrafts([...(await getDrafts()), d]);
      return d;
    }
    case "practice": {
      const d = (await getDrafts()).find((o) => o.id === msg.id) ?? (await getOrder(msg.id));
      if (!d) throw new Error("No such order");
      return practiceDraft(d);
    }
    case "approve": {
      const drafts = await getDrafts();
      const d = drafts.find((o) => o.id === msg.id);
      if (!d) throw new Error("No such draft");
      d.approved = true;
      // Approving a changed order replaces the old one, and keeps its record of what was
      // already reported, so the new version doesn't tell you about the same things again.
      const old = d.replaces ? await getOrder(d.replaces) : undefined;
      if (old) {
        await setSeen(d.id, await getSeen(old.id));
        await browser.alarms.clear(`order:${old.id}`);
        await saveOrders((await getOrders()).filter((o) => o.id !== old.id));
        await event("changed", { from: old.id, to: d.id });
      }
      await putOrder(d);
      await setDrafts(drafts.filter((o) => o.id !== msg.id));
      await schedule(d);
      await event("approved", { id: d.id, from: d.from ?? null });
      // A watcher's first real check happens now, not a whole period later.
      if (d.trigger.kind === "every") runOrder(d, "schedule");
      return d;
    }
    case "discard": {
      await event("discarded", { id: msg.id });
      await setDrafts((await getDrafts()).filter((o) => o.id !== msg.id));
      return true;
    }
    case "run": {
      const o = await getOrder(msg.id);
      if (!o) throw new Error("No such order");
      if (o.trigger.kind === "on_visit") {
        const tab = await currentWebTab();
        if (!tab || !tab.url.startsWith(o.trigger.match)) throw new Error(`This one works on ${o.trigger.match.replace(/^https?:\/\//, "")}. Open that page and it runs by itself.`);
        return runOrder(o, "manual", tab.id);
      }
      return runOrder(o, "manual");
    }
    case "pause": {
      const o = await getOrder(msg.id);
      if (!o) throw new Error("No such order");
      o.paused = msg.paused;
      await putOrder(o);
      await schedule(o);
      await event(msg.paused ? "paused" : "resumed", { id: o.id });
      broadcast();
      return o;
    }
    case "cancel": {
      await browser.alarms.clear(`order:${msg.id}`);
      await saveOrders((await getOrders()).filter((o) => o.id !== msg.id));
      await event("cancelled", { id: msg.id });
      broadcast();
      return true;
    }
    case "share": {
      const o = await getOrder(msg.id) ?? (await getDrafts()).find((d) => d.id === msg.id);
      if (!o) throw new Error("No such order");
      const { id, sentence, createdAt, approved, paused, version, repairs, from, layoutOnly, ...draft } = o;
      await event("shared", { id });
      const file: OrderFile = { format: "marching-orders/1", sentence, draft, sharedAt: new Date().toISOString() };
      return file;
    }
    case "import": {
      const f = msg.file;
      if (f?.format !== "marching-orders/1") throw new Error("That isn't a Marching Orders file.");
      const parsed = Draft.safeParse(f.draft);
      if (!parsed.success) throw new Error("That order file is damaged or from a newer version.");
      const d: Order = { ...parsed.data, id: uid(), sentence: f.sentence, createdAt: Date.now(), approved: false, paused: false, version: 1, repairs: 0, from: f.from ?? "a shared file" };
      await setDrafts([...(await getDrafts()), d]);
      await event("imported", { id: d.id, sentence: d.sentence });
      return d;
    }
    case "settings": {
      const cur = await getSettings();
      const next = { ...cur, ...msg.settings };
      if (msg.settings.apiKey === undefined) next.apiKey = cur.apiKey;
      await browser.storage.local.set({ settings: next });
      broadcast();
      return true;
    }
    case "export-study": {
      // What the study needs, without page contents: events, run outcomes, the orders' steps.
      const [orders, log, events] = await Promise.all([getOrders(), getLog(), browser.storage.local.get("events")]);
      return {
        exportedAt: new Date().toISOString(),
        orders: orders.map((o) => ({ id: o.id, sentence: o.sentence, trigger: o.trigger, model: o.model, steps: o.steps.map((s) => s.do), version: o.version, repairs: o.repairs, from: o.from ?? null, paused: o.paused, createdAt: o.createdAt })),
        runs: log.map(({ told, steps, items, matches, ...r }) => ({ ...r, told: told.length, matches: matches?.length ?? 0 })),
        events: events.events ?? [],
      };
    }
  }
}

browser.runtime.onMessage.addListener((msg: Msg) => handle(msg).then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })));

declare const __TEST__: boolean;
// Test build only: a tab that opens .../__sidebar is turned into the sidebar
// page, so automation (which can't open extension pages) gets a handle on it.
if (__TEST__) {
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url?.includes("/__sidebar")) browser.tabs.update(tabId, { url: browser.runtime.getURL("sidebar.html") });
  });
}

// Re-arm alarms when the extension starts.
getOrders().then((orders) => orders.forEach(schedule));
export { usesModel };
