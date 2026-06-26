// Simple proxy server — run once, keeps running in background
// Fetches job data from APIs and serves it to the HTML file
const http = require('http');
const https = require('https');

// Render (and most hosts) assign a port at runtime via process.env.PORT.
// Falls back to 3131 for local development, where you run this directly.
const PORT = process.env.PORT || 3131;

// Hard ceiling on any single upstream response body. Job board APIs/RSS feeds
// should never legitimately need more than a few MB; this guards against a
// misconfigured endpoint or unexpected streaming response silently consuming
// unbounded memory before we ever get to JSON.parse.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB

function fetchUrl(url, asText) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': asText ? '*/*' : 'application/json',
        // Critical: tell the server NOT to compress the response.
        // Many sources (Cloudflare-fronted APIs especially) gzip/brotli by
        // default; Node's raw https.get does not auto-decompress, so a
        // compressed body fed straight into JSON.parse fails with a
        // confusing "invalid JSON" error. Requesting identity encoding
        // avoids that entirely.
        'Accept-Encoding': 'identity'
      },
      timeout: 10000
    }, (res) => {
      // Follow one redirect (some sources 301/302)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, asText).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) {
        // Drain the body so the socket can close cleanly, but don't need its content
        let errBody = '';
        res.on('data', chunk => errBody += chunk);
        res.on('end', () => {
          const preview = errBody.slice(0, 500);
          const err = new Error(`HTTP ${res.statusCode} from ${new URL(url).hostname}: ${preview}`);
          err.statusCode = res.statusCode;
          reject(err);
        });
        return;
      }
      let data = '';
      let bytesReceived = 0;
      let aborted = false;
      res.on('data', chunk => {
        if (aborted) return;
        bytesReceived += chunk.length;
        if (bytesReceived > MAX_RESPONSE_BYTES) {
          aborted = true;
          res.destroy(); // stop the inbound stream immediately, don't keep buffering
          reject(new Error(`Response from ${new URL(url).hostname} exceeded ${MAX_RESPONSE_BYTES / (1024*1024)}MB limit — aborted to avoid unbounded memory use`));
          return;
        }
        data += chunk;
      });
      res.on('end', () => {
        if (aborted) return; // rejection already sent above
        if (asText) { resolve(data); return; }
        try { resolve(JSON.parse(data)); }
        catch (e) {
          // Include enough of the raw body to diagnose (e.g. HTML error page,
          // truncated response, or leftover compressed bytes) without dumping
          // megabytes into the error message.
          const preview = data.slice(0, 120).replace(/[\x00-\x1F\x7F-\x9F]/g, '?');
          reject(new Error(`Invalid JSON from ${new URL(url).hostname}: "${preview}"`));
        }
      });
    });
    req.on('error', (e) => reject(new Error(`Network error reaching ${new URL(url).hostname}: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out after 10s contacting ${new URL(url).hostname}`)); });
  });
}

// ── Minimal RSS <item> parser for We Work Remotely ──────────────
function parseWWRRss(xml) {
  const items = [];
  // Cap how many <item> blocks we even bother parsing — we only ever need 25
  // in the end, so there's no reason to fully parse a feed that returned far
  // more than expected (defensive against a malformed or unexpectedly large feed).
  const MAX_ITEMS_TO_PARSE = 100;
  const itemBlocks = xml.split('<item>').slice(1, MAX_ITEMS_TO_PARSE + 1);

  // We Work Remotely's feed double-escapes the HTML inside its <description>
  // CDATA block — i.e. the actual real tags (<p>, <strong>, <img>, ...) are
  // stored as HTML entities (&lt;p&gt;, &lt;strong&gt;, ...) rather than as
  // literal markup. Stripping the CDATA wrapper alone leaves those entities
  // intact, so the frontend later sees what LOOKS like tags once a browser
  // decodes them once via innerHTML, but they were never real markup to begin
  // with — they render as literal visible text instead of being parsed as
  // structure. Decoding entities here, server-side, turns them back into real
  // characters, so the frontend's HTML parser can recognize them as actual tags.
  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, '&')   // must run before the others, or e.g. &amp;lt; would double-decode
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  for (const block of itemBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      if (!m) return '';
      return m[1]
        .replace('<![CDATA[', '').replace(']]>', '')
        .trim();
    };
    // Some RSS items repeat a tag multiple times (e.g. several <category> entries
    // per job). get() above only ever returns the first match — getAll() captures
    // every occurrence so multi-category listings aren't silently truncated to one.
    const getAll = (tag) => {
      const matches = [...block.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
      return matches
        .map(m => m[1].replace('<![CDATA[', '').replace(']]>', '').trim())
        .filter(Boolean);
    };
    const title = get('title');
    // WWR titles are usually "Company: Job Title"
    let company = '', position = title;
    const splitIdx = title.indexOf(':');
    if (splitIdx > -1) {
      company = title.slice(0, splitIdx).trim();
      position = title.slice(splitIdx + 1).trim();
    }
    const link = get('link');
    const description = decodeEntities(get('description'));
    const pubDate = get('pubDate');
    const region = get('region');
    const categories = getAll('category');
    if (title) {
      items.push({ title: position, company, url: link, description, pubDate, region, categories });
    }
  }
  return items;
}

// The only origin allowed to call this proxy. Locally this stays '*' so the
// file:// or localhost frontend can reach it freely. Once deployed, set the
// ALLOWED_ORIGIN environment variable on Render to your actual frontend URL
// (e.g. https://your-app.onrender.com) — anyone calling from elsewhere will
// be rejected before any upstream job-board request is even made.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Simple in-memory rate limiter ───────────────────────────────
// Once this server is publicly reachable, anyone (not just your own
// frontend) could call it directly. This caps how many requests a single
// IP can make per minute. It's intentionally simple — in-memory, resets on
// restart, not shared across multiple server instances — which is fine for
// a single small Render instance, but wouldn't scale to a multi-instance
// deployment without a shared store (e.g. Redis).
const RATE_LIMIT_MAX = 60;         // max requests per IP per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const requestCounts = new Map();   // ip -> { count, windowStart }

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Periodically clear stale entries so the Map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) requestCounts.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

const server = http.createServer(async (req, res) => {
  const requestOrigin = req.headers.origin || '';
  const originIsAllowed = ALLOWED_ORIGIN === '*' || requestOrigin === ALLOWED_ORIGIN;

  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN === '*' ? '*' : (originIsAllowed ? requestOrigin : ALLOWED_ORIGIN));
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end('{}'); return; }

  // Reject anything not coming from the allowed origin once one is actually
  // configured. Browsers already enforce CORS on the response side, but this
  // catches direct (non-browser) requests too — e.g. someone curling your
  // proxy URL straight from the command line.
  if (ALLOWED_ORIGIN !== '*' && !originIsAllowed && req.headers.origin !== undefined) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  // Rate limit by client IP. req.socket.remoteAddress is what Node gives us
  // directly; Render sits behind a proxy, so x-forwarded-for (when present)
  // reflects the actual visitor rather than Render's internal proxy address.
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    res.writeHead(429);
    res.end(JSON.stringify({ error: 'Too many requests — please slow down and try again in a minute.' }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const q = url.searchParams;

  try {
    // Health check
    if (path === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Server running' }));
      return;
    }

    // Remotive proxy
    if (path === '/remotive') {
      const params = new URLSearchParams({ limit: '25' });
      const search = q.get('search');
      if (search) params.set('search', search);
      const apiUrl = `https://remotive.com/api/remote-jobs?${params}`;
      console.log('[Remotive]', apiUrl);
      const data = await fetchUrl(apiUrl);
      // Defensive cap: don't trust the upstream limit param to be honored.
      const safeData = (data && Array.isArray(data.jobs))
        ? { ...data, jobs: data.jobs.slice(0, 25) }
        : { jobs: [] };
      res.writeHead(200);
      res.end(JSON.stringify(safeData));
      return;
    }

    // Jobicy proxy
    if (path === '/jobicy') {
      const tag = (q.get('tag') || 'product-manager').toLowerCase().trim();
      const apiUrl = `https://jobicy.com/api/v2/remote-jobs?count=25&tag=${encodeURIComponent(tag)}`;
      console.log('[Jobicy]', apiUrl);
      const data = await fetchUrl(apiUrl);
      // Defensive cap: don't trust the upstream count param to be honored.
      const safeData = (data && Array.isArray(data.jobs))
        ? { ...data, jobs: data.jobs.slice(0, 25) }
        : { jobs: [] };
      res.writeHead(200);
      res.end(JSON.stringify(safeData));
      return;
    }

    // Himalayas proxy — free public JSON API, no key required
    // Attribution required by Himalayas terms: link back + mention Himalayas as source (handled in UI)
    if (path === '/himalayas') {
      const search = q.get('search') || '';
      const limit = q.get('limit') || '20';
      const params = new URLSearchParams({ page: '1', limit });
      if (search) params.set('q', search);
      const apiUrl = `https://himalayas.app/jobs/api/search?${params}`;
      console.log('[Himalayas]', apiUrl);
      const data = await fetchUrl(apiUrl);
      // Defensive cap: don't trust the upstream `limit` param to be honored.
      // If `data.jobs` is unexpectedly huge (or not an array at all), this
      // keeps the response — and everything downstream that processes it —
      // bounded rather than trusting an external API's behavior blindly.
      const safeData = (data && Array.isArray(data.jobs))
        ? { ...data, jobs: data.jobs.slice(0, 25) }
        : { jobs: [] };
      res.writeHead(200);
      res.end(JSON.stringify(safeData));
      return;
    }

    // Remote OK proxy — free public JSON API, no key, no native search param
    // (we fetch the firehose and filter server-side by title/tags/description)
    if (path === '/remoteok') {
      const search = (q.get('search') || '').toLowerCase();
      const apiUrl = 'https://remoteok.com/api';
      console.log('[RemoteOK]', apiUrl, '(filter:', search, ')');
      const data = await fetchUrl(apiUrl);
      // First element is a legal/metadata blob, not a job — drop it
      let jobs = Array.isArray(data) ? data.slice(1) : [];
      if (search) {
        const terms = search.split(/\s+/).filter(Boolean);
        jobs = jobs.filter(j => {
          const hay = `${j.position || ''} ${(j.tags || []).join(' ')} ${j.description || ''}`.toLowerCase();
          return terms.every(t => hay.includes(t));
        });
      }
      res.writeHead(200);
      res.end(JSON.stringify({ jobs: jobs.slice(0, 25) }));
      return;
    }

    // We Work Remotely proxy — official public RSS feed, parsed to JSON server-side
    if (path === '/wwr') {
      const search = (q.get('search') || '').toLowerCase();
      const apiUrl = 'https://weworkremotely.com/remote-jobs.rss';
      console.log('[WeWorkRemotely]', apiUrl, '(filter:', search, ')');
      const xml = await fetchUrl(apiUrl, true);
      let jobs = parseWWRRss(xml);
      if (search) {
        const terms = search.split(/\s+/).filter(Boolean);
        jobs = jobs.filter(j => {
          const hay = `${j.title || ''} ${j.company || ''} ${(j.categories||[]).join(' ')} ${j.description || ''}`.toLowerCase();
          return terms.every(t => hay.includes(t));
        });
      }
      res.writeHead(200);
      res.end(JSON.stringify({ jobs: jobs.slice(0, 25) }));
      return;
    }

    // Levels.fyi proxy — fetches the publicly published markdown salary page
    // for a given company slug. No official API exists; Levels.fyi publishes
    // these .md pages specifically for programmatic/LLM consumption.
    // Attribution to Levels.fyi is required and shown in the UI.
    if (path === '/levels') {
      const slug = (q.get('company') || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      if (!slug) { res.writeHead(400); res.end(JSON.stringify({ error: 'company slug required' })); return; }
      const apiUrl = `https://www.levels.fyi/companies/${slug}/salaries.md`;
      console.log('[Levels.fyi]', apiUrl);
      try {
        const text = await fetchUrl(apiUrl, true);
        // A missing company still returns 200 with a near-empty page on some setups;
        // treat very short bodies as "not found" rather than guessing at content.
        if (!text || text.length < 200 || /not found/i.test(text.slice(0, 300))) {
          res.writeHead(200);
          res.end(JSON.stringify({ found: false, slug }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ found: true, slug, markdown: text }));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ found: false, slug, error: e.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Unknown route' }));

  } catch (err) {
    console.error('[Error]', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('✓ Job Intelligence server running on port ' + PORT);
  if (!process.env.PORT) {
    console.log('  Local URL: http://localhost:' + PORT);
    console.log('  Open job-intelligence.html in your browser');
  }
  console.log('  Sources: Remotive, Jobicy, Himalayas, Remote OK, We Work Remotely, Levels.fyi');
  console.log('  Press Ctrl+C to stop');
  console.log('');
});
