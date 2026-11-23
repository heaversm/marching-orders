// Fixed-code clean-up of whatever the writer returns, so the same mistakes can't
// slip through from a weaker model. Pure functions, unit-tested in e2e/normalize.mjs.
import { Draft, Step, Trigger, usesModel } from "./order";
import { origin } from "./urls";

/** A schedule stated plainly in the sentence, if any: "once a week", "every 2 hours", "daily at 7am". */
export function timingFrom(sentence: string): Trigger | null {
  const s = sentence.toLowerCase();
  const at = /(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
  if (/\b(daily|every day|each day|every morning|each morning|every evening)\b/.test(s)) {
    if (at) {
      let h = parseInt(at[1]) % 12;
      if (at[3] === "pm") h += 12;
      if (!at[3] && parseInt(at[1]) === 12) h = 12;
      return { kind: "daily", at: `${String(h).padStart(2, "0")}:${at[2] ?? "00"}` };
    }
    return { kind: "every", minutes: 1440 };
  }
  const n = /every\s+(\d+|two|three|four)\s+(minute|hour|day|week)s?/.exec(s);
  const unit: Record<string, number> = { minute: 1, hour: 60, day: 1440, week: 10080 };
  const word: Record<string, number> = { two: 2, three: 3, four: 4 };
  if (n) return { kind: "every", minutes: (word[n[1]] ?? parseInt(n[1])) * unit[n[2]] };
  if (/\b(hourly|every hour|once an hour)\b/.test(s)) return { kind: "every", minutes: 60 };
  if (/\b(weekly|every week|once a week|each week)\b/.test(s)) return { kind: "every", minutes: 10080 };
  if (/\b(fortnightly|every other week|biweekly)\b/.test(s)) return { kind: "every", minutes: 20160 };
  return null;
}

export function normalize(d: Draft, sentence: string, pageUrl?: string): Draft {
  const steps: Step[] = [...d.steps];
  let sites = [...d.sites];
  let trigger = d.trigger;
  // The person stated a schedule but the writer chose "only when you press Run": the sentence wins.
  const stated = timingFrom(sentence);
  if (stated && trigger.kind === "manual") trigger = stated;
  // An order that reads a page but never opens one: open the page it was written on.
  if (pageUrl && trigger.kind !== "on_visit" && steps.some((s) => s.do === "collect") && !steps.some((s) => s.do === "open")) {
    steps.unshift({ do: "open", url: pageUrl });
    sites.push(origin(pageUrl));
  }
  // A watcher on a repeating timer that reads items should only report new ones; without
  // this it would repeat the same items every run. Daily orders (a forecast) are left alone.
  if (trigger.kind === "every" && steps.some((s) => s.do === "collect") && !steps.some((s) => s.do === "only_new")) {
    const at = steps.findIndex((s) => s.do === "notify");
    steps.splice(at >= 0 ? at : steps.length, 0, { do: "only_new", field: "" });
  }
  // An order that reads items but never tells you or changes the page does nothing you can see.
  const collect = steps.find((s) => s.do === "collect");
  if (collect && collect.do === "collect" && !steps.some((s) => s.do === "notify" || s.do === "hide" || s.do === "highlight")) {
    const shown = collect.fields.filter((f) => f.attribute === "text").slice(0, 2).map((f) => `{${f.name}}`);
    steps.push({ do: "notify", title: d.title, line: shown.join(" — ") || `{${collect.key}}`, only_if: [] });
  }
  const out = { ...d, steps, trigger, sites: [...new Set(sites.map(origin).filter(Boolean))] };
  return { ...out, model: usesModel(out) ? (d.model === "none" ? "local" : d.model) : "none" };
}
