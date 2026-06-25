# Remote Job Intelligence

A remote job search tool that pulls real listings from five public job boards, then uses Groq's AI to analyze each job's actual description — extracting required skills with deep-dive explanations, and giving you company intel — rather than just listing raw search results.

**Sources:** Remotive, Jobicy, Himalayas, Remote OK, We Work Remotely · **Salary data:** Levels.fyi (public pages)

---

## How it's structured

Two pieces:

- **`job-intelligence.html`** — the entire frontend (UI + logic), a single static file. Calls Groq directly from your browser.
- **`server.js`** — a small proxy server. Job boards either block direct browser requests (CORS) or need server-side parsing (We Work Remotely's RSS feed). This proxy sits between your browser and those sources.

Your **Groq API key lives only in your browser's `localStorage`** — it is never sent to or stored by `server.js`. The proxy server only ever talks to job boards; it has no knowledge of your key.

---

## Running it locally

1. Install [Node.js](https://nodejs.org) (free, ~1 minute) if you don't already have it.
2. In a terminal, in the folder with these files, run:
   ```
   node server.js
   ```
   You should see:
   ```
   ✓ Job Intelligence server running on port 3131
     Local URL: http://localhost:3131
   ```
3. Open `job-intelligence.html` directly in your browser (double-click it, or drag it into a browser tab).
4. Paste a free [Groq API key](https://console.groq.com) into the banner on first use. It's saved in your browser only — you won't need to re-enter it next time, even after restarting the server.
5. Search. Leave the terminal window open while you use the app — closing it stops the proxy server.

No `npm install` needed — `server.js` only uses Node's built-in `http`/`https` modules.

---

## Deploying it as a real website

The app is built to support this without code changes — just configuration. You deploy **two separate services**:

| Service | What it is | Where |
|---|---|---|
| Backend | `server.js` + `package.json` | Render Web Service (Node) |
| Frontend | `job-intelligence.html` | Render Static Site (or Netlify/Vercel/GitHub Pages) |

### Steps

1. **Push these files to a GitHub repo** — `server.js`, `package.json`, `job-intelligence.html` together.
2. **Deploy the backend:** Render → "New +" → "Web Service" → connect your repo. Render auto-detects Node via `package.json`; the start command (`npm start`) is already set correctly. Choose the **Free** tier. Deploy, then copy the URL Render gives you (e.g. `https://your-app-xyz.onrender.com`).
3. **Deploy the frontend:** Render → "New +" → "Static Site" → same repo. No build command needed (it's a plain HTML file) — leave the publish directory at the repo root. Deploy, then copy *this* URL too.
4. **Connect the two** (see [Environment variables](#environment-variables) below):
   - In `job-intelligence.html`, set `DEPLOYED_API_URL` to your backend's URL from step 2.
   - On the **backend** service in Render's dashboard, add an environment variable `ALLOWED_ORIGIN` set to your frontend's URL from step 3.
   - Commit/push the HTML change and let both services redeploy.

### A note on Render's free tier

Free web services on Render spin down after ~15 minutes of no traffic. The *next* request after that wakes it back up, which takes 30–60 seconds — so the first search after a quiet period will feel slow once, then fast again until it goes idle again. This is a Render platform behavior, not a bug in this app. If that wait ever becomes annoying, Render's paid tier (~$7/month) removes it entirely — no code changes needed, just a plan upgrade.

---

## Environment variables (backend only)

Set these in Render's dashboard under your **backend** service → Environment. Locally, you can ignore both — sensible defaults are used automatically.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3131` | Set automatically by Render at runtime. Don't set this yourself. |
| `ALLOWED_ORIGIN` | `*` (open to everyone) | Restricts which frontend domain may call this proxy. Set to your deployed frontend's exact URL (e.g. `https://your-frontend.onrender.com`) once it exists. Leave unset for local development. |

---

## Built-in safety limits

These exist because once `server.js` is publicly reachable, it's no longer just talking to your own browser — it's a public endpoint anyone could hit directly.

- **8MB response cap** — any single response from a job board is capped at 8MB; oversized or malformed responses are aborted rather than buffered into memory indefinitely.
- **100-item RSS parse cap** — We Work Remotely's feed is only parsed up to 100 `<item>` entries (well above the ~25 jobs actually used), protecting against an unexpectedly large feed.
- **25-job cap per source** — enforced server-side on every route, regardless of what the upstream API claims to honor.
- **Rate limiting** — 60 requests per minute per IP address, in-memory (resets if the server restarts). Returns HTTP 429 once exceeded.
- **CORS restriction** — once `ALLOWED_ORIGIN` is set, requests from any other origin are rejected with HTTP 403 before any job-board API is even called.

---

## How the AI analysis works

When you search, the app fetches up to 24 jobs across all active sources, then splits them into **4 batches of ~6 jobs** and analyzes all 4 batches **in parallel** with Groq — this is a fixed cost of **4 API calls per search**, regardless of how many jobs you click into afterward.

Each batch asks Groq to read every job's own description individually and return:
- **Skills** specific to that job, with deep-dive explanations (what it actually is, why this employer wants it, how to build it)
- **Company intel** (what they do, stage, target market, growth) — deduplicated across jobs that share the same employer, so a company is only described once even if multiple of its listings appear in your results

The aggregate **Skills Analysis** tab is built by combining these per-job results client-side — it is not a separate API call.

If a batch fails (e.g. a rate limit on Groq's side), the affected jobs are clearly marked as "not analysed" rather than silently showing wrong or stale data, and the status bar reports exactly how many of the 4 batches succeeded.

### Estimated cost

Based on this app's actual prompt size, a single search costs roughly **$0.01** on Groq's Developer tier (pay-as-you-go, no monthly minimum). Even 10 searches a day, every day, lands around $2/month. The free tier works too, but its lower tokens-per-minute limit can cause some of the 4 parallel batches to fail under regular use — the Developer tier (just add a card at [console.groq.com](https://console.groq.com), no code changes needed) removes that ceiling.

---

## Known limitations

- Levels.fyi salary data depends on their public markdown pages existing for a given company slug — many smaller companies won't have a match, and the app says so plainly rather than guessing.
- Company intel quality depends on Groq's own general knowledge — well-known companies get richer, more reliable intel than small or obscure ones, which may come back as "not enough reliable information" rather than an invented description.
- The in-memory rate limiter resets on server restart and isn't shared across multiple instances — fine for a single small deployment, not built for horizontal scaling.
