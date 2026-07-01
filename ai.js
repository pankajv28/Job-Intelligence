// ════════════════════════════════════════════════════════════════
// AI — everything about talking to the AI provider lives here.
// This is the file you edit when switching providers (currently
// Groq). The request shape, response parsing, the prompt text, and
// where the API key(s) are stored are all in this one place — no AI
// provider details leak into any other file.
// ════════════════════════════════════════════════════════════════
import { AI_CONFIG, BATCH_CONFIG, RESULT_LIMITS } from './config.js';

// ── Strip HTML down to plain text (used to feed job descriptions
// into the prompt without raw markup confusing the model) ───────
function strip(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent.replace(/\s+/g, ' ').trim().slice(0, 700);
}

// ── API key storage ──────────────────────────────────────────────
// Keys live ONLY in localStorage, never sent anywhere except directly
// to the AI provider from the browser. The backend server never sees
// them. saveKey() is called from two places in the UI (the first-run
// banner and the settings popover) — both write to the same storage
// key so they always agree.
export function getKey() { return localStorage.getItem(AI_CONFIG.keyStorageName) || ''; }
export function setKey(value) { localStorage.setItem(AI_CONFIG.keyStorageName, value); }
export function clearKeyStorage() { localStorage.removeItem(AI_CONFIG.keyStorageName); }

// Second, optional key — used to roughly double effective throughput
// by splitting batch analysis across two independent rate limits.
export function getKey2() { return localStorage.getItem(AI_CONFIG.key2StorageName) || ''; }
export function setKey2(value) { localStorage.setItem(AI_CONFIG.key2StorageName, value); }
export function clearKey2Storage() { localStorage.removeItem(AI_CONFIG.key2StorageName); }

// Stagger delay (seconds) between a single key's own batches.
export function getStaggerDelay() {
  const stored = parseFloat(localStorage.getItem('stagger_delay'));
  return (!isNaN(stored) && stored >= 0 && stored <= BATCH_CONFIG.maxStaggerSeconds) ? stored : BATCH_CONFIG.defaultStaggerSeconds;
}
export function setStaggerDelay(seconds) {
  const safe = (!isNaN(seconds) && seconds >= 0 && seconds <= BATCH_CONFIG.maxStaggerSeconds) ? seconds : BATCH_CONFIG.defaultStaggerSeconds;
  localStorage.setItem('stagger_delay', String(safe));
  return safe;
}

export function isValidKey(key) {
  if (!key) return false;
  return AI_CONFIG.keyPrefix ? key.startsWith(AI_CONFIG.keyPrefix) : true;
}

// ── Prompt builder ───────────────────────────────────────────────
// Builds the instruction text sent to the AI for one batch of jobs.
// Kept as its own function (rather than inline in the request code)
// so wording tweaks don't require touching network-call logic.
function buildPrompt(jobs) {
  const jobBlocks = jobs.map((j) =>
    `JOB_ID: ${j.id}\nTitle: "${j.title}" at ${j.company}\nSalary: ${j.salary || 'not listed'}\nSource tags: ${(j.tags || []).slice(0, RESULT_LIMITS.maxTagsInPrompt).join(', ') || 'none'}\nDescription: ${strip(j.description)}`
  ).join('\n\n---\n\n');

  return `Analyse these ${jobs.length} REAL remote job listings ONE BY ONE. For each job, extract skills genuinely required based on ITS OWN description text, and describe the hiring company using general knowledge (never invent specifics inconsistent with public knowledge — if you don't have enough reliable information about a company, say so honestly instead of guessing).

${jobBlocks}

Return ONLY valid JSON (no markdown, no preamble), one entry per job, in the same order as given:
{
  "jobs":[
    {
      "jobId":"<the JOB_ID exactly as given above>",
      "skills":[{"name":"<skill explicitly in or clearly implied by this job's own description>","category":"domain|technical|soft|tool"}],
      "skillDeepDives":[{
        "name":"<skill name, matching one from this job's skills list — pick the 3-5 most strategically important for THIS job>",
        "category":"domain|technical|soft|tool",
        "what":"<3-4 sentences explaining FROM FIRST PRINCIPLES what this skill actually involves day-to-day for this specific role — assume the reader has not heard the term before. No buzzword-only definitions.>",
        "why":"<2-3 sentences on why THIS company, given what its job posting and business reveal, specifically wants this skill>",
        "steps":[{"step":"<concrete, specific action — name a real resource, tool, or method where possible>","time":"<time estimate like '3 hrs' or '1 week'>"},{"step":"<step 2>","time":"<time>"},{"step":"<step 3, often about how to talk about it in an interview>","time":"<time>"}],
        "totalTime":"<e.g. '2-3 weeks to interview-ready'>",
        "priority":"<one of: High ROI — prioritise this | Medium priority — contextual | Your background is leverage here>"
      }],
      "company":{
        "name":"<company name, exact as given>",
        "tagline":"<1-2 sentence plain description of what the company does and who it serves, OR exactly 'Not enough reliable public information about this company.' if you genuinely don't know>",
        "stage":"<one of: early-stage, growth-stage, late-stage private, public, unknown>",
        "targetMarket":["<bullet on who buys/uses their product>","<optional 2nd bullet — mark caution-worthy ones by starting with 'Caution:'>"],
        "growth":["<concrete metric or development from roughly the last 2 years, with direction (up/flat/down) implied by the wording — omit entirely if unknown rather than guessing>"]
      },
      "salaryNote":"<1 short sentence on this job's specific salary, or 'Not listed.' if none given>"
    }
  ]
}
Rules: cover EVERY job listed above, in order, using its exact JOB_ID. 4-8 skills per job, only from that job's own text. 2-4 skillDeepDives per job. For "company", if you have no reliable knowledge of a small/obscure company beyond its name, use the exact fallback tagline text given above and set stage to "unknown" rather than inventing detail.`;
}

// ── The actual provider call ─────────────────────────────────────
// Sends one batch of jobs to the AI provider and returns the parsed
// per-job results. This is the function to rewrite when switching
// providers: the endpoint, request body shape, auth header, and
// response parsing are all provider-specific and all live right here.
async function analyseJobBatch(jobs, key) {
  const prompt = buildPrompt(jobs);

  const res = await fetch(AI_CONFIG.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: AI_CONFIG.model,
      temperature: AI_CONFIG.temperature,
      max_tokens: AI_CONFIG.maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error?.message || `AI provider error ${res.status}`);
  }
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content || '';
  text = text.replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]); else throw new Error('Could not parse AI response');
  }
  return parsed.jobs || [];
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Batch orchestration ──────────────────────────────────────────
// Splits all jobs into `numBatches` batches and analyses them using
// whichever key(s) are saved. If a second key is set, batches
// alternate between the two keys (key A: batches 0,2 / key B: batches
// 1,3) — each key has its own independent rate limit on the
// provider's side, so this roughly doubles total throughput. Batches
// sharing the SAME key are staggered by the saved delay to stay under
// that key's own tokens-per-minute ceiling; batches on DIFFERENT keys
// need no such delay between them, since they don't share a limit.
//
// Returns: { byJobId: Map<jobId, jobResult>, byCompany: Map<companyNameLower, companyResult>, errors: string[] }
export async function runBatchedAnalysis(allJobs, key, numBatches = BATCH_CONFIG.numBatches) {
  const key2 = getKey2();
  const hasTwoKeys = !!key2;
  const staggerMs = getStaggerDelay() * 1000;

  const batches = [];
  const batchSize = Math.ceil(allJobs.length / numBatches);
  for (let i = 0; i < allJobs.length; i += batchSize) {
    batches.push(allJobs.slice(i, i + batchSize));
  }
  const nonEmptyBatches = batches.filter(b => b.length);

  // Assign each batch to a key, and compute how long to wait before
  // firing it, based on how many prior batches share the same key.
  const tasks = nonEmptyBatches.map((batchJobs, i) => {
    const assignedKey = hasTwoKeys ? (i % 2 === 0 ? key : key2) : key;
    const keyLabel = hasTwoKeys ? (i % 2 === 0 ? 'A' : 'B') : 'A';
    const priorSameKeyCount = hasTwoKeys ? Math.floor(i / 2) : i;
    const delayMs = priorSameKeyCount * staggerMs;
    return { batchJobs, assignedKey, keyLabel, batchIndex: i, delayMs };
  });

  const settled = await Promise.allSettled(tasks.map(async t => {
    if (t.delayMs > 0) await sleep(t.delayMs);
    return analyseJobBatch(t.batchJobs, t.assignedKey);
  }));

  const byJobId = new Map();
  const byCompany = new Map(); // first-seen company writeup wins; later duplicates are skipped
  const errors = [];

  settled.forEach((res, i) => {
    const t = tasks[i];
    if (res.status === 'fulfilled') {
      res.value.forEach(jobResult => {
        if (!jobResult.jobId) return;
        byJobId.set(jobResult.jobId, jobResult);
        const companyKey = (jobResult.company?.name || '').toLowerCase().trim();
        if (companyKey && !byCompany.has(companyKey)) {
          byCompany.set(companyKey, jobResult.company);
        }
      });
    } else {
      const msg = res.reason?.message || 'Unknown error';
      errors.push(`Batch ${t.batchIndex + 1} (key ${t.keyLabel}) failed: ${msg}`);
      console.warn(`[Analysis batch ${t.batchIndex + 1}, key ${t.keyLabel}]`, msg);
    }
  });

  return { byJobId, byCompany, errors };
}
