// URL helpers shared by the sidebar and background (kept apart from order.ts so
// the sidebar doesn't bundle zod).
export const origin = (url: string) => {
  try { return new URL(url).origin; } catch { return ""; }
};
/** Match pattern for an origin; Firefox match patterns ignore ports. */
export const pattern = (o: string) => {
  const u = new URL(o);
  return `${u.protocol}//${u.hostname}/*`;
};

/** "{today+7}" (also URL-encoded, "%7Btoday%2B7%7D") -> the date 7 days from now, YYYY-MM-DD, local time. */
export function datedUrl(u: string, now = new Date()) {
  return u.replace(/(?:\{|%7B)today(?:(\+|%2B|-)(\d+))?(?:\}|%7D)/gi, (_, sign: string | undefined, n: string | undefined) => {
    const d = new Date(now);
    d.setDate(d.getDate() + (n ? (sign === "-" ? -1 : 1) * parseInt(n) : 0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
}
