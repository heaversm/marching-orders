// What an order is. The writer (a model) produces one of these from a sentence;
// the runner carries it out with fixed code. Nothing in an order is executable:
// it is a list of steps from a closed set, so it can be read, checked against
// the sites it is allowed to touch, and shared as a plain file.
import { z } from "zod";

const Field = z.object({
  name: z.string().describe("Short field name, e.g. title, price, link"),
  selector: z.string().describe("CSS selector relative to the item. Empty string means the item element itself"),
  attribute: z.string().describe('What to read: "text", or an attribute name such as "href" or "datetime"'),
});

const Test = z.enum(["less_than", "more_than", "at_most", "at_least", "between", "contains", "not_contains", "equals"]);
const Condition = z.object({
  field: z.string(),
  test: Test,
  value: z.string().describe('Number or text to compare against. Numbers are read from the field, ignoring $ and commas. For "between" give "low..high", e.g. "7..10"'),
});
/** A check over all current items, e.g. "total rain is more than 0.1" or "at least 1 rainy hour between 7 and 10". */
const Measure = z.object({
  measure: z.enum(["count", "sum", "max", "min"]),
  field: z.string().describe("Field to add up or compare. Ignored for count"),
  where: z.array(Condition).describe("Only count or add up items that pass all of these. Empty means every item"),
  test: Test,
  value: z.string(),
});

export const Step = z.discriminatedUnion("do", [
  z.object({ do: z.literal("open"), url: z.string().describe("Full URL. Must be on one of the order's sites. May contain {today+N} (or {today}), replaced with the date N days from the day it runs, as YYYY-MM-DD") }),
  z.object({
    do: z.literal("read_also"),
    urls: z.array(z.string()).describe("More URLs (may use {today+N}). For each, the steps between the last open and here (clicks and the collect) are repeated and the items added. Use it to cover several searches, e.g. one per week of a month"),
  }),
  z.object({
    do: z.literal("collect"),
    items: z.string().describe("CSS selector that matches each repeated item, e.g. each listing card"),
    fields: z.array(Field),
    key: z.string().describe("Name of the field that identifies an item, used to tell new items from ones already seen (a link is best)"),
  }),
  z.object({
    do: z.literal("compute"),
    name: z.string().describe("Name of the new field"),
    from: z.array(z.string()).describe("Fields it is worked out from, in order"),
    how: z.enum(["percent_off", "minus", "number", "hours", "time_of_day", "day", "days_between", "dates"]).describe(
      "dates: the first two dates found, as 'Dec 11–Dec 15' (use as an identity when labels carry changing words). days_between: the number of days between the first two dates found in the fields, e.g. 'Dec 7 to Dec 11' gives 4. percent_off: from [now_price, was_price] gives the % saved (0 if no was_price). minus: from [a, b] gives a minus b. number: the first number in the field. hours: a duration like '7 hr 25 min' as hours (7.42). time_of_day: a time like '3:30 pm' as hours since midnight (15.5). day: from [time] in a list of hours, 0 for the first day, 1 once the times wrap past midnight, and so on (so 'today only' is day equals 0)",
    ),
  }),
  z.object({ do: z.literal("keep"), ...Condition.shape }),
  z.object({
    do: z.literal("keep_any"),
    tests: z.array(Condition).describe("Keep an item if it passes any one of these"),
  }),
  z.object({
    do: z.literal("judge"),
    question: z.string().describe("A yes/no question asked of a model about each item. Only for conditions a keep step cannot express"),
  }),
  z.object({
    do: z.literal("only_new"),
    field: z.string().default("").describe("Field that identifies an item, if not the collect step's key (e.g. a dates field when the label also carries changing words). Empty means the key"),
  }),
  z.object({ do: z.literal("summarize"), instruction: z.string().describe("What a model should write about the items") }),
  z.object({
    do: z.literal("notify"),
    title: z.string().describe("May use {count}, and {sum:field}, {max:field} or {min:field}"),
    line: z.string().describe("Template for each item, using {field} placeholders, e.g. '{title} — {price}'"),
    only_if: z.array(Measure).default([]).describe("Notify only if any one of these checks passes. Empty means notify whenever there are items"),
  }),
  z.object({
    do: z.literal("click"),
    label: z.string().describe("Visible text or label of a button or tab to click to show information, e.g. 'Date grid'. Never anything that buys, books, sends, signs in or changes settings: the runner refuses those"),
  }),
  z.object({
    do: z.literal("page_through"),
    labels: z.array(z.string()).describe("Labels of the buttons to click, in order, each time, e.g. [\"Next\"] or [\"Scroll right\", \"Scroll down\"]"),
    times: z.number().describe("How many times to click them (at most 40). After each round the last collect step is read again and new items are added"),
  }),
  z.object({ do: z.literal("hide"), selector: z.string().describe("Elements to hide on the page") }),
  z.object({ do: z.literal("highlight"), selector: z.string().describe("Elements to outline on the page") }),
]);
export type Step = z.infer<typeof Step>;
export type Condition = z.infer<typeof Condition>;
export type Measure = z.infer<typeof Measure>;

export const Trigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every"), minutes: z.number().describe("How often to run, in minutes. At least 1. A week is 10080, two weeks 20160") }),
  z.object({ kind: z.literal("daily"), at: z.string().describe('Local time each day, 24-hour "HH:MM", e.g. "07:00"') }),
  z.object({ kind: z.literal("on_visit"), match: z.string().describe("Run when a page whose URL starts with this is opened") }),
  z.object({ kind: z.literal("manual") }),
]);
export type Trigger = z.infer<typeof Trigger>;

/** What the writer returns. */
export const Draft = z.object({
  can_do: z.boolean().describe("False if the steps available cannot carry out this order"),
  cannot_reason: z.string().describe("If can_do is false, one plain sentence saying why. Otherwise empty"),
  title: z.string().describe("Three to six words, e.g. 'Cheap 2-beds on Maple Rentals'"),
  summary: z.string().describe("One plain sentence saying what the order does, for the person approving it"),
  trigger: Trigger,
  sites: z.array(z.string()).describe("Origins the order may touch, e.g. https://example.com"),
  model: z.enum(["none", "local", "cloud"]).describe("Which model judge/summarize steps use. none if there are no such steps"),
  steps: z.array(Step),
});
export type Draft = z.infer<typeof Draft>;

export interface Order extends Draft {
  id: string;
  sentence: string;
  createdAt: number;
  approved: boolean;
  paused: boolean;
  /** Bumped whenever the steps change (a repair). */
  version: number;
  repairs: number;
  /** Who wrote it, if imported. */
  from?: string;
  /** The writer saw this page's layout only, never its text; repairs do the same, and
   * judge/summarize steps always run on the local model. */
  layoutOnly?: boolean;
  /** A draft made with Change: approving it replaces this order. */
  replaces?: string;
}

export interface StepNote { do: string; note: string; ok: boolean }
export interface RunRecord {
  orderId: string;
  version: number;
  at: number;
  why: "practice" | "schedule" | "visit" | "manual";
  ok: boolean;
  error?: string;
  steps: StepNote[];
  found: number;
  kept: number;
  told: string[];
  modelCalls: { local: number; cloud: number };
  repaired: boolean;
  ms: number;
  /** Things that worked but look wrong, e.g. a field empty on every item. */
  warnings: string[];
  /** What was kept, on practice runs only (so the draft card and tests can show it). Never exported. */
  items?: Record<string, string>[];
  /** Everything that currently passes the order's filters, with a link, and whether it's new this run. Never exported. */
  matches?: { line: string; url: string; new: boolean }[];
}

/** The file someone shares. */
export interface OrderFile {
  format: "marching-orders/1";
  sentence: string;
  draft: Draft;
  sharedAt: string;
  from?: string;
}

export { origin, pattern } from "./urls";
export const usesModel = (d: Draft) => d.steps.some((s) => s.do === "judge" || s.do === "summarize");
