# Remote Job Intelligence

A remote job search tool that pulls live listings from five public job boards, then uses AI to analyse each job's actual description — extracting required skills with deep-dive explanations and company intel — rather than just listing raw search results.

**Sources:** Remotive, Jobicy, Himalayas, Remote OK, We Work Remotely · **Salary data:** Levels.fyi (public pages)

---

## How it's structured

The project is split into focused files, each with one job:

| File | What it does |
|---|---|
| `index.html` | Page structure (markup only, no logic) |
| `styles.css` | All visual styling |
| `config.js` | Every tunable setting in one place — AI model, batch count, limits, colours |
| `sources.js` | Job board registry — fetchers, relevance filter, Levels.fyi lookup |
| `ai.js` | Everything about talking to the AI provider — prompt, API call, key storage |
| `render.js` | Turns data into what you see on screen |
| `app.js` | Conductor — holds state, wires up controls, runs the search flow |
| `server.js` | Small Node.js proxy — bypasses CORS restrictions from job boards and parses We Work Remotely's RSS feed |

**Your AI API key lives only in your browser's `localStorage`** — it is never sent to or stored by `server.js`. The proxy only ever talks to job boards.

---

## Running it locally

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. In a terminal inside this folder, run:
   ```
   node server.js
   ```
   You should see:
   ```
   ✓ Job Intelligence server running on port 3131
   ```
3. Serve the frontend with any local server. The simplest option:
   ```
   python -m http.server 8080
   ```
   Then open `http://localhost:8080` in your browser.

   > **Why can't I just double-click `index.html`?**
   > The new modular structure uses ES modules (`import`/`export`), which browsers block when opening files directly via `file://`. A local server fixes this instantly.

4. Paste a free [Groq API key](https://console.groq.com) into the banner on first use. It's saved in your browser only.

No `npm install` needed — `server.js` uses only Node's built-in modules.

---

## Deployed setup

The frontend and backend are hosted separately:

| Piece | Hosting | URL |
|---|---|---|
| Frontend (static files) | Cloudflare Pages | `https://job-intelligence.pages.dev` |
| Backend (proxy server) | Render (free tier) | `https://job-intelligence.onrender.com` |

### How they're connected

Two values need to match each other:

- `DEPLOYED_API_URL` in `config.js` → must point to the Render backend URL
- `ALLOWED_ORIGIN` env variable on the Render backend → must be set to the Cloudflare frontend URL

If you redeploy either service to a new URL, update both values.

---

## Deploying changes

### Backend (`server.js`)
Push to GitHub — Render auto-deploys on every push to `main`. No other steps needed.

### Frontend (all other files)
Push to GitHub — Cloudflare Pages auto-deploys on every push to `main`. No other steps needed.

---

## Configuration

All tunable values live in `config.js`. Nothing else needs touching for common adjustments:

| Setting | What it controls |
|---|---|
| `AI_CONFIG.endpoint` | AI provider API URL — change this when switching providers |
| `AI_CONFIG.model` | Model name |
| `BATCH_CONFIG.numBatches` | How many parallel AI calls per search (default: 4) |
| `BATCH_CONFIG.defaultStaggerSeconds` | Delay between batches on the same key (default: 3s) |
| `RESULT_LIMITS.maxJobsPerSearch` | Jobs analysed per search (default: 24) |
| `DISPLAY_CONFIG.inrPerUsd` | USD → INR conversion rate for salary display |
| `DISPLAY_CONFIG.newBadgeHours` | How recent a job must be to show the "New" badge |
| `CAT` | Skill category colours |

---

## Adding a new job board

Open `sources.js` only. Write a `fetchX()` function that returns jobs in the standard shape, then add one line each to `SOURCE_FETCHERS` and `SOURCE_LABELS`. No other file needs touching.

---

## Switching AI providers

Open `ai.js` and `config.js` only:

- In `config.js`: update `AI_CONFIG.endpoint`, `AI_CONFIG.model`, `AI_CONFIG.keyStorageName`, `AI_CONFIG.keyPrefix`
- In `ai.js`: update the request body shape and response parsing in `analyseJobBatch()` to match the new provider's API

No other file knows anything about which AI provider is in use.

---

## How the AI analysis works

Each search fetches up to 24 jobs, splits them into 4 batches, and analyses all 4 in parallel — a fixed cost of **4 API calls per search** regardless of how many jobs you click into afterward.

Each batch asks the AI to read every job's description individually and return:
- **Skills** specific to that job, with deep-dive explanations (what it is, why this employer wants it, how to build it)
- **Company intel** (what they do, stage, target market, growth) — deduplicated so a company is only described once even if multiple listings appear

The aggregate **Skills Analysis** tab combines these per-job results client-side — it is not a separate API call.

If a batch fails (e.g. a rate limit), affected jobs are clearly marked as "not analysed" and the status bar reports exactly how many batches succeeded.

---

## Built-in safety limits (server.js)

| Limit | Value | Purpose |
|---|---|---|
| Response cap | 8 MB | Prevents unbounded memory use from oversized upstream responses |
| RSS parse cap | 100 items | Guards against unexpectedly large We Work Remotely feeds |
| Per-source job cap | 25 jobs | Enforced server-side regardless of upstream API behaviour |
| Rate limit | 60 requests/min/IP | Returns HTTP 429 once exceeded; resets on server restart |
| CORS restriction | Set via `ALLOWED_ORIGIN` | Rejects requests from any other origin with HTTP 403 |

---

## Known limitations

- Levels.fyi salary data only exists for companies with a public markdown page — smaller companies often won't have a match.
- Company intel quality depends on the AI's general knowledge — obscure companies may return "not enough reliable information" rather than invented detail.
- The rate limiter is in-memory and resets on server restart — fine for a single small deployment.
