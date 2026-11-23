// Two invented sites for testing orders, on http://localhost:8090.
//   /listings  Maple Rentals: apartment cards, drawn by JavaScript after load
//   /news      The Daily Ledger: headlines, some marked sponsored
//   /shoes     Crag Outfitters: climbing shoes with sale and original prices
//   /hourly    Rain or Shine: an hourly forecast (?rain=wet|dry|commute)
//   /account   a login page; /blocked a bot-check page
// Controls (for tests and demos):
//   /admin/add?title=..&price=..&beds=..   add a listing
//   /admin/redesign?on=1                   new markup and class names (breaks old selectors)
//   /admin/reset                           back to the starting listings
// Usage: node test-site/server.mjs [port]
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 8090);
const START = [
  { id: "a1", title: "Sunny 2-bed near Elm Park", price: 2650, beds: 2, hood: "Elm Park" },
  { id: "a2", title: "Renovated 2-bed, laundry in unit", price: 3100, beds: 2, hood: "Riverside" },
  { id: "a3", title: "Studio above the bakery", price: 1700, beds: 0, hood: "Old Town" },
  { id: "a4", title: "Quiet 1-bed with balcony", price: 2200, beds: 1, hood: "Elm Park" },
  { id: "a5", title: "Big 3-bed for a family", price: 3900, beds: 3, hood: "Hillcrest" },
  { id: "a6", title: "2-bed garden flat — WIRE DEPOSIT TODAY to hold", price: 1200, beds: 2, hood: "Riverside" },
];
let listings = structuredClone(START);
let redesign = false;
let next = 7;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 Georgia,serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}
.listing,.c9x2{border:1px solid #ddd;border-radius:8px;padding:12px;margin:10px 0}
.price,.k7{font-weight:bold;color:#0a6}.sponsored{background:#fffbe6}nav a{margin-right:12px}</style></head>
<body><nav><a href="/listings">Listings</a><a href="/news">News</a></nav>${body}</body></html>`;

const listingsPage = () => page("Maple Rentals — apartments", `
<h1>Maple Rentals</h1><p>Apartments for rent, newest first.</p>
<main id="results"><p>Loading…</p></main>
<script>
fetch("/api/listings").then(r => r.json()).then(({ listings, redesign }) => {
  const el = document.getElementById("results");
  el.innerHTML = listings.map(l => redesign
    ? '<div class="c9x2" data-ref="' + l.id + '"><h3 class="t1">' + l.title + '</h3><b class="k7">$' + l.price.toLocaleString() + ' monthly</b> · <i>' + (l.beds ? l.beds + " bedrooms" : "studio") + '</i> · ' + l.hood + ' <a class="go" href="/listings/' + l.id + '">See it</a></div>'
    : '<article class="listing" data-id="' + l.id + '"><h2 class="title"><a href="/listings/' + l.id + '">' + l.title + '</a></h2><span class="price">$' + l.price.toLocaleString() + '/mo</span> · <span class="beds">' + (l.beds ? l.beds + " bd" : "Studio") + '</span> · <span class="hood">' + l.hood + '</span></article>'
  ).join("");
});
</script>`);

const NEWS = [
  { h: "Council approves new bike lanes on Main St", s: false },
  { h: "You won't BELIEVE what this celebrity eats for breakfast", s: false },
  { h: "Sponsored: The mattress that changed my life", s: true },
  { h: "School board delays budget vote to March", s: false },
  { h: "10 shocking photos that will make you cry", s: false },
  { h: "Sponsored: Refinance today and save", s: true },
  { h: "Library extends weekend hours", s: false },
];
const newsPage = () => page("The Daily Ledger", `<h1>The Daily Ledger</h1>
<ul id="stories">${NEWS.map((n, i) => `<li class="story${n.s ? " sponsored" : ""}" data-kind="${n.s ? "ad" : "news"}"><a href="/news/${i}">${n.h}</a></li>`).join("")}</ul>`);

const SHOES = [
  { name: "Crimper Pro", size: "10", now: 99, was: 0 },
  { name: "Slab Slipper", size: "9.5", now: 129, was: 179 },
  { name: "Edge Lord", size: "11", now: 80, was: 0 },
  { name: "Big Wall Classic", size: "10.5", now: 150, was: 160 },
  { name: "Gym Rat", size: "9", now: 89, was: 0 },
];
const shoesPage = () => page("Crag Outfitters — climbing shoes", `<h1>Climbing shoes</h1>
<ul class="products">${SHOES.map((s) => `<li class="product-card"><a class="product-link" href="/shoes/${s.name.toLowerCase().replace(/ /g, "-")}"><span class="product-name">${s.name}</span></a>
<span class="size">Men's ${s.size}</span> <span class="price-now">$${s.now.toFixed(2)}</span>${s.was ? ` <s class="price-was">$${s.was.toFixed(2)}</s>` : ""}</li>`).join("")}</ul>`);

// Hourly forecast. wet: 0.3 in total, none at commute times. commute: rain at 8am and 4:30pm only (0.06 in total). dry: none.
const hourlyPage = (kind) => {
  const rows = [];
  for (let h = 6; h <= 21; h++) {
    let rain = 0;
    if (kind === "wet" && h >= 11 && h <= 14) rain = 0.075;
    if (kind === "commute" && (h === 8 || h === 16)) rain = 0.03;
    const label = `${((h + 11) % 12) + 1}${h === 16 ? ":30" : ""} ${h < 12 ? "am" : "pm"}`;
    rows.push(`<tr class="hour"><td class="time">${label}</td><td class="temp">${48 + (h % 7)}°</td><td class="chance">${rain ? 80 : 5}%</td><td class="amount">${rain.toFixed(2)} in</td></tr>`);
  }
  return page("Rain or Shine — hourly", `<h1>Hourly forecast</h1><table id="hourly"><tr><th>Time</th><th>Temp</th><th>Chance</th><th>Rain</th></tr>${rows.join("")}</table>`);
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  if (url.pathname === "/" || url.pathname === "/listings") return send(200, "text/html", listingsPage());
  if (url.pathname === "/api/listings") return send(200, "application/json", JSON.stringify({ listings: [...listings].reverse(), redesign }));
  if (url.pathname.startsWith("/listings/")) {
    const l = listings.find((x) => x.id === url.pathname.split("/")[2]);
    return l ? send(200, "text/html", page(l.title, `<h1>${l.title}</h1><p>$${l.price}/mo · ${l.hood}</p>`)) : send(404, "text/plain", "not found");
  }
  if (url.pathname === "/__sidebar") return send(200, "text/html", "<p>Opening the sidebar…</p>");
  if (url.pathname === "/shoes") return send(200, "text/html", shoesPage());
  if (url.pathname === "/hourly") return send(200, "text/html", hourlyPage(url.searchParams.get("rain") ?? "wet"));
  if (url.pathname.startsWith("/bank/activity")) return send(200, "text/html", page("Activity — Maple Bank", `<h1>Recent activity</h1><p>Card ending 4417</p>
<div class="tx-list">${[["Nov 18", "TOTAL WINE & MORE #1123", "$48.12"], ["Nov 17", "SAFEWAY 1490", "$83.40"], ["Nov 16", "BREAKSIDE BREWERY", "$22.00"], ["Nov 15", "PORTLAND GENERAL ELEC", "$96.18"], ["Nov 14", "POWELLS BOOKS", "$31.75"]].map(([d, m, a], i) => `<div class="tx-row" data-row="${i}"><span class="tx-date">${d}</span><div class="tx-desc"><a href="/bank/activity/tx/${i}">${m}</a></div><span class="tx-amt">${a}</span></div>`).join("")}</div>`));
  if (url.pathname === "/slow") return send(200, "text/html", page("Slow list", `<h1>Slow list</h1><ul id="slow"></ul><script>setTimeout(() => { document.getElementById("slow").innerHTML = ["one", "two", "three"].map((t) => '<li class="late"><a href="/slow/' + t + '">' + t + '</a></li>').join(""); }, 5000);</script>`));
  if (url.pathname === "/tabs") return send(200, "text/html", page("Hourly with tabs", `<h1>Hourly</h1><button id="precip">Precipitation</button><div id="view">${["7 am", "8 am", "9 am"].map((t) => `<div class="hour-default"><b>${t}</b> 50°</div>`).join("")}</div>
<script>document.getElementById("precip").onclick = () => { document.getElementById("view").innerHTML = ["7 am", "8 am", "9 am"].map((t) => '<div class="hour-precip"><b>' + t + '</b> 0.02 in</div>').join(""); };</script>`));
  if (url.pathname === "/grid") return send(200, "text/html", page("Fake flights", `<h1>Flights PDX to MTJ</h1>
<button id="open-grid">Date grid</button> <button id="book">Book this flight</button>
<div id="dlg" role="dialog" hidden><div id="cells"></div><button aria-label="Scroll right" id="right">›</button><button aria-label="Scroll down" id="down">⌄</button></div>
<script>
// Like Google's date grid: 7 departure days x 7 return days. Scroll right moves departures one
// day later, Scroll down moves returns one day later. Cells with return before departure are
// left out. 3-5 day trips leaving Dec 9 or Dec 20 are $350, others $480. The cheapest cells in
// view get "low price" in their label, so the same trip can be labelled two ways.
const qs = new URLSearchParams(location.search);
let dep = Number(qs.get("dep") ?? 1), ret = dep + 3;
const draw = () => {
  const cells = [];
  for (let d = dep; d < dep + 7; d++) for (let r = ret; r < ret + 7; r++) {
    if (r <= d) continue;
    const len = r - d, price = (len >= 3 && len <= 5 && (d === 9 || d === 20)) ? 350 : 480;
    cells.push('<div role="button" class="cell" aria-label="$' + price + (price < 400 ? ', low price' : '') + ', Dec ' + d + ' to Dec ' + r + '">$' + price + '</div>');
  }
  document.getElementById("cells").innerHTML = cells.join("");
};
document.getElementById("open-grid").onclick = () => { document.getElementById("dlg").hidden = false; draw(); };
document.getElementById("right").onclick = () => { dep += 1; draw(); };
document.getElementById("down").onclick = () => { ret += 1; draw(); };
document.getElementById("book").onclick = () => { document.title = "BOOKED"; };
</script>`));
  if (url.pathname === "/account") return send(200, "text/html", page("Sign in — Maple Bank", `<h1>Sign in</h1><form><label>Username <input name="u"></label><label>Password <input type="password" name="p"></label><button>Log in</button></form>`));
  if (url.pathname === "/blocked") return send(200, "text/html", page("Access Denied", `<h1>Access Denied</h1><p>You don't have permission to access this page.</p>`));
  if (url.pathname === "/news") return send(200, "text/html", newsPage());
  if (url.pathname.startsWith("/news/")) return send(200, "text/html", page("Story", `<h1>${NEWS[+url.pathname.split("/")[2]]?.h ?? "?"}</h1>`));
  if (url.pathname === "/admin/add") {
    const l = { id: `a${next++}`, title: url.searchParams.get("title") ?? "New listing", price: Number(url.searchParams.get("price") ?? 2500), beds: Number(url.searchParams.get("beds") ?? 2), hood: url.searchParams.get("hood") ?? "Elm Park" };
    listings.push(l);
    return send(200, "application/json", JSON.stringify(l));
  }
  if (url.pathname === "/admin/redesign") { redesign = url.searchParams.get("on") !== "0"; return send(200, "text/plain", `redesign ${redesign}`); }
  if (url.pathname === "/admin/reset") { listings = structuredClone(START); redesign = false; next = 7; return send(200, "text/plain", "reset"); }
  send(404, "text/plain", "not found");
}).listen(PORT, () => console.log(`test sites on http://localhost:${PORT} (/listings, /news)`));
