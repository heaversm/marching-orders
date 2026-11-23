# Marching Orders

A Firefox extension prototype. You write one sentence ("Tell me when a 2-bed under $2,800 shows up on this page"). An AI model turns it into an **order**: a short list of steps from a fixed set (open a page, read the items, keep the ones under $2,800, skip ones already reported, notify me). You approve it, and from then on it runs by itself on a timer or whenever you open a page, with no AI involved unless a step needs judgment.

It's a research prototype that tests one claim: people who don't write code will make tools for their own weekly chores when making one takes a sentence, and AI only needs to write and repair those tools, not run them.

Prompted by Paul Kinlan's [prompt-in-a-box](https://github.com/PaulKinlan/prompt-in-a-box), a Chrome extension whose program is a markdown prompt run by a model every time. Marching Orders differs in three ways:
- **The model writes steps once; plain code runs them.** It is called again only to repair a step after a site changes, or for a step that needs judgment ("does this look like a scam?"). Every model call is counted in the log.
- **Firefox enforces the limits.** An order lists the sites it may touch. Approving it asks Firefox for exactly those sites, and the runner refuses to open anything else.
- **Orders are files you can read and share.** No code inside, so a friend can see what it does before running it.

## Try it

Needs Node 24+.

```
npm install
npx @puppeteer/browsers install firefox@stable --path .browsers
npm run try
```

`npm run try` opens a **separate** Firefox, the copy downloaded into `.browsers/`, never your everyday one. It has the extension installed, the sidebar open, and two invented test sites in tabs:
- **Maple Rentals:** apartment listings
- **The Daily Ledger:** news with sponsored stories

Orders and settings persist in `.profile/` between runs.

In the sidebar:
- **Settings (⚙):** paste an Anthropic API key, or switch the writer to the local model.
- **Give an order:** type a sentence and press **Draft it**. Firefox asks to read the page. The draft shows what the order may touch, whether it sends data anywhere, and its steps, and it has already done a practice run (no notifications, nothing remembered).
- **Approve and start:** Firefox asks for the order's sites, then the order runs on its own.
- **Share:** saves an `.marching-order.json` file. **Import an order…** loads one.
- **Export study log:** what orders did, without what they found. This is for the friends-and-colleagues study.

Test-site controls:
- `curl "http://localhost:8090/admin/add?title=New%202-bed&price=2500&beds=2"` adds a listing.
- `curl "http://localhost:8090/admin/redesign"` changes the site's markup, which makes orders repair themselves.
- `curl "http://localhost:8090/admin/reset"` starts over.

### In your everyday Firefox

Use this for sites that block the automated test Firefox (REI), and for sites you're logged into (your bank). Orders here use your real logins.

**Setup, each time you start**
- In Terminal, in this folder, run `npm run build`, then `npm run relay`. Leave that Terminal window open. The relay passes Claude calls through for Anthropic organizations that refuse calls from browsers. Nothing else needs it.
- In Firefox, go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `dist/manifest.json` in this folder.
- Open the sidebar: **View → Sidebar → Marching Orders**.
- In the sidebar, click ⚙, paste your Anthropic API key, and click **Save**. This Firefox keeps its own copy, separate from the test Firefox.

A temporary add-on is removed when Firefox quits, and its orders and key probably go with it *(not checked)*. Getting it signed by Mozilla would make it permanent; that isn't done yet.

**REI climbing shoes**
- Open rei.com → climbing shoes. Use REI's own filters for Men's and sizes 9.5, 10 and 10.5, so the page shows only those.
- In the sidebar, type: `Check every week for these climbing shoes under $105 or at least 25% off`. Leave **Use this page** ticked, and click **Draft it**.
- Firefox asks to let Marching Orders read rei.com. Click **Allow**.
- Read the draft card: what it may touch, its steps, and what the practice run found. If it looks right, click **Approve and start**.
- If the practice run says the site blocked the check, REI blocks hidden tabs too.

**Bank: alcohol purchases** (local model only, so transactions never leave this computer)
- Do the one-time Ollama setting under **Using the local model (Ollama)** below.
- In the sidebar's ⚙, set **Who writes your orders** to **Local model**, and click **Save**.
- Log in to your bank and open the page that lists recent transactions.
- In the sidebar, type: `Every hour, tell me about any purchase at a liquor store, wine shop, brewery, bar or bottle shop`. Click **Draft it**, then **Allow** when Firefox asks.
- The local model takes 1–2 minutes. Check the practice run's list against what you see on the page, then approve.
- Limits:
  - It sees only the store's name, not what you bought, so beer bought at a supermarket won't show.
  - When the bank logs you out, the order says "log in again" and waits.

### If Claude calls fail with "CORS requests are not allowed"

Some Anthropic organizations (those with custom data-retention settings) refuse any call made from a browser. The extension detects this and switches to a small relay on this computer, which forwards calls to Anthropic the way a normal program would. It stores nothing; the key arrives with each request. `npm run try` starts it for you. With your everyday Firefox, run `npm run relay` and leave it running.

### Using the local model (Ollama)

Ollama only answers programs it trusts. By default it turns away Firefox extensions, answering "403 forbidden", and an extension can't disguise where its requests come from. One setting tells Ollama to accept them:
- Quit Ollama: click the llama icon in the menu bar → **Quit Ollama**.
- In Terminal, run: `launchctl setenv OLLAMA_ORIGINS "moz-extension://*"`
- Open Ollama again from Applications.
- To check it: run `curl -s -H "Origin: moz-extension://test" http://localhost:11434/api/tags`. A list of models means it worked; `403` means Ollama was still running when you set it.

The setting lasts until the Mac restarts. After a restart, do the same three steps again. The model is chosen in the sidebar's Settings (default `qwen3:14b`).

## An example order file

[`examples/cheap-2-beds-on-maple-rentals.marching-order.json`](examples/cheap-2-beds-on-maple-rentals.marching-order.json) is the file **Share** saved in the two-person test (`e2e/share.mjs`). It contains the sentence and the order's steps. It doesn't contain the order's history or anything the order found.

## Tests

- `npm test`: end-to-end checks in the downloaded Firefox, headless. They cover import, practice, approval and Firefox's site grant, runs, new listings, a site redesign and repair, blocked sites, hiding page parts on visit, a judgment step, sharing, pause, the timer, and the study export. Model steps use a local Ollama on port 11435, started like this: `OLLAMA_HOST=127.0.0.1:11435 OLLAMA_ORIGINS="moz-extension://*" ollama serve`. Add `--skip-slow` to skip the model and timer checks.
- `npm run test:real -- <url> "<sentence>"`: drafts an order with Claude on a real public page and prints the steps and the practice run. Uses the key saved by `npm run try`, so quit that window first.
- `node e2e/share.mjs`: two separate Firefox profiles. One approves and runs an order and presses **Share**. The other imports the file, then practices, approves and runs it.
- `node e2e/capture.mjs`, then `node e2e/render-shots.mjs`: screenshots of the extension for documentation, saved to `shots/` (set `SHOTS_DIR` to save elsewhere). The capture loads orders from files, so it makes no paid AI calls.
- `npm run test:writer`: gives the writer the same sentences several times and counts how often the practice run gets the right answer. `-- --cloud` uses Claude. Each draft is one paid API call.

## How it's built

| File | What it does |
|---|---|
| `src/order.ts` | The order format: the closed set of steps, triggers, sites (zod schema, also sent to the model as the output format) |
| `src/model.ts` | Writing an order from a sentence plus a page outline, repairing one step, and judge/summarize steps. Claude (`claude-opus-5-5`) or Ollama |
| `src/background.ts` | Storage, the runner (hidden tabs, Firefox site checks), timers, page-visit triggers, the log and study events |
| `src/page.ts` | Functions run inside pages: the outline, reading items, hiding or outlining parts of the page |
| `src/sidebar.ts` | The sidebar |
| `test-site/server.mjs` | The two invented sites |
| `lib/relay.mjs` | Forwards Claude calls for organizations that refuse calls from browsers. Listens on 127.0.0.1 only, and only for extension pages |
| `e2e/` | Tests. `lib/try.mjs` is the launcher |

Firefox features it relies on, which Chrome lacks or limits: hidden tabs (`tabs.hide`), so orders read logged-in pages without tabs flashing up; a sidebar built into the browser; and background scripts with a DOM.

## Known gaps

- Sites with strong bot protection (REI) block the automated test Firefox, so they can only be tried in a normal Firefox.
- Flights: one date pair per order; a range of 3–5-day trips isn't expressible yet.
- Repair only covers the step that reads items, and only when it finds nothing.
- No form filling or clicking, so chores like "copy my receipts into a spreadsheet" can't be expressed yet.
- Shared order files aren't signed, so there's no proof of who wrote one.
- Page text reaches the model only as data, never as instructions to the runner. A judge step's answer can still be swayed by a crafted page.
