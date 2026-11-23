// Functions that run inside a web page via scripting.executeScript. Each one
// must be self-contained: Firefox serializes the function's source, so it
// cannot use imports or anything defined outside its own body.

/** A compact outline of the page for the writer: tags, ids, classes, data-*
 * attributes, links and short text. Long runs of look-alike siblings are cut
 * to a few examples, so a page of 200 listings shows 3 plus "...197 more". */
export function outlinePage(maxChars: number, layoutOnly = false): string {
  // Layout only: every letter becomes x/X and every digit 9, so the writer sees where
  // things are and what kind of text they are ("$99.99", "Xxx 99") but not what they say.
  const m = (t: string) => (layoutOnly ? t.replace(/[A-Z]/g, "X").replace(/[a-z]/g, "x").replace(/[0-9]/g, "9") : t);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "TEMPLATE", "LINK", "META", "PATH"]);
  const out: string[] = [];
  let size = 0;
  const sig = (el: Element) => el.tagName + "." + [...el.classList].sort().join(".");
  const attrs = (el: Element) => {
    const parts: string[] = [];
    // Ids and class names are the page's code, not its content, but an id with digits may be an account number.
    if (el.id) parts.push(`id="${layoutOnly && /\d/.test(el.id) ? m(el.id) : el.id}"`);
    if (el.classList.length) parts.push(`class="${[...el.classList].join(" ")}"`);
    for (const a of [...el.attributes]) {
      if (a.name.startsWith("data-") || ["href", "datetime", "aria-label", "role", "name", "type"].includes(a.name)) {
        const keep = ["role", "type"].includes(a.name) || (a.name === "href" && !layoutOnly);
        parts.push(`${a.name}="${(keep ? a.value : m(a.value)).slice(0, 80)}"`);
      }
    }
    return parts.length ? " " + parts.join(" ") : "";
  };
  const push = (s: string) => { if (size < maxChars) { out.push(s); size += s.length + 1; } };
  const walk = (el: Element, depth: number) => {
    if (SKIP.has(el.tagName.toUpperCase()) || size >= maxChars) return;
    const style = el instanceof HTMLElement ? getComputedStyle(el) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return;
    const pad = "  ".repeat(Math.min(depth, 20));
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join(" ").replace(/\s+/g, " ");
    const kids = [...el.children];
    const tag = el.tagName.toLowerCase();
    push(`${pad}<${tag}${attrs(el)}>${own ? " " + m(own.slice(0, 100)) : ""}`);
    let i = 0;
    while (i < kids.length) {
      const s = sig(kids[i]);
      let j = i;
      while (j < kids.length && sig(kids[j]) === s) j++;
      const run = j - i;
      const show = run > 4 ? 3 : run;
      for (let k = i; k < i + show; k++) walk(kids[k], depth + 1);
      if (run > show) {
        // Show the rest as one line of text each, so the writer sees the range of values (e.g. "Studio").
        const rest = kids.slice(i + show, j);
        push(`${pad}  ...${run - show} more <${kids[i].tagName.toLowerCase()}> like the ones above. Their text:`);
        for (const r of rest.slice(0, 15)) push(`${pad}    | ${m((r.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120))}`);
        if (rest.length > 15) push(`${pad}    | ...and ${rest.length - 15} more`);
      }
      i = j;
    }
  };
  push(`URL: ${layoutOnly ? location.origin + m(location.pathname) : location.href}`);
  push(`Title: ${m(document.title)}`);
  if (layoutOnly) push("(Layout only: letters are shown as x/X and digits as 9.)");
  walk(document.body, 0);
  if (size >= maxChars) out.push("...(outline cut short)");
  return out.join("\n");
}

/** Read each item matching `items` and pull the named fields out of it. */
export function collectItems(items: string, fields: { name: string; selector: string; attribute: string }[]) {
  const read = (root: Element, f: { selector: string; attribute: string }) => {
    let el: Element | null = root;
    try { el = f.selector ? root.querySelector(f.selector) : root; } catch { return ""; }
    if (!el) return "";
    if (f.attribute === "text" || !f.attribute) return (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (f.attribute === "href" && el instanceof HTMLAnchorElement) return el.href; // absolute
    return el.getAttribute(f.attribute) ?? "";
  };
  let nodes: Element[] = [];
  try { nodes = [...document.querySelectorAll(items)]; } catch (e) { return { error: `Bad selector: ${items}`, rows: [] }; }
  const rows = nodes.slice(0, 200).map((n) => Object.fromEntries(fields.map((f) => [f.name, read(n, f)])));
  return { error: "", rows };
}

/** Hide or outline elements. Marks them so a second run doesn't stack styles. */
export function restyle(selector: string, how: "hide" | "highlight") {
  let nodes: Element[] = [];
  try { nodes = [...document.querySelectorAll(selector)]; } catch { return -1; }
  for (const n of nodes) {
    if (!(n instanceof HTMLElement)) continue;
    if (how === "hide") n.style.setProperty("display", "none", "important");
    else n.style.setProperty("outline", "3px solid #ff7139", "important");
    n.dataset.marchingOrders = how;
  }
  return nodes.length;
}

/** True once the page has settled: loaded, and no DOM changes for `quietMs`. */
export function waitForQuiet(quietMs: number, maxMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const cap = setTimeout(done, maxMs);
    function done() { obs.disconnect(); clearTimeout(cap); clearTimeout(timer); resolve(true); }
  });
}

/** Is the page asking for a login, or a bot check? Used before treating "found nothing" as a broken order. */
export function pageState(): { login: boolean; blocked: string } {
  const text = (document.body?.innerText ?? "").slice(0, 5000);
  const pw = [...document.querySelectorAll("input[type=password]")].some((el) => (el as HTMLElement).offsetParent !== null);
  const loginWords = /\b(sign in|log in|login|signin)\b/i.test(document.title + " " + text.slice(0, 1500));
  const m = /(access denied|are you a robot|verify you are human|unusual traffic|captcha|press (and|&) hold|request blocked|pardon our interruption)/i.exec(document.title + " " + text);
  return { login: pw && loginWords, blocked: m ? m[1] : "" };
}

/** Click the visible button, tab or link whose label or text matches `label`, if it is
 * safe: never a submit button, a link to another site, or anything that sounds like
 * buying, booking, sending, signing in or out, or deleting. */
export function clickLabel(label: string): { clicked: boolean; why: string } {
  const want = label.trim().toLowerCase();
  const vis = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const name = (e: Element) => ((e.getAttribute("aria-label") || (e as HTMLElement).innerText || e.textContent || "").trim().replace(/\s+/g, " "));
  const all = [...document.querySelectorAll("button, [role=button], [role=tab], a, summary")].filter(vis);
  const exact = all.filter((e) => name(e).toLowerCase() === want);
  const starts = all.filter((e) => name(e).toLowerCase().startsWith(want));
  const el = (exact[0] ?? starts[0]) as HTMLElement | undefined;
  if (!el) return { clicked: false, why: `No button labelled “${label}” on the page` };
  const text = name(el);
  if (/\b(buy|book|purchase|pay|checkout|check out|order now|submit|send|delete|remove|confirm|sign in|sign out|log in|log out|subscribe|unsubscribe)\b/i.test(text)) return { clicked: false, why: `Refused to click “${text}”: orders only click to show information` };
  if (el.closest("form") && (el.getAttribute("type") === "submit" || (el.tagName === "BUTTON" && !el.getAttribute("type")))) return { clicked: false, why: `Refused to click “${text}”: it would submit a form` };
  if (el instanceof HTMLAnchorElement && el.href && new URL(el.href, location.href).origin !== location.origin) return { clicked: false, why: `Refused to click “${text}”: it leads to another site` };
  el.click();
  return { clicked: true, why: text };
}
