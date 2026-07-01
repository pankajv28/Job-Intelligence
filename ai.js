// ════════════════════════════════════════════════════════════════
// AI — everything about the AI analysis lives here.
// The API key is now on the SERVER (Render env var DEEPSEEK_API_KEY),
// not in the browser. The browser sends job data to /ai on your own
// server.js, which forwards it to DeepSeek and returns the result.
// This permanently solves the CORS problem — browser never contacts
// DeepSeek directly.
//
// To switch AI providers: update config.js + the /ai route in server.js.
// Nothing else needs touching.
// ════════════════════════════════════════════════════════════════
import { AI_CONFIG, BATCH_CONFIG, RESULT_LIMITS } from './config.js';

// ── Strip HTML to plain text ─────────────────────────────────────
// Feeds clean text to the AI — raw HTML tags in the prompt confuse
// the model and waste tokens.
function strip(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent.replace(/\s+/g, ' ').trim().slice(0, 700);
}

// ── Prompt builder ───────────────────────────────────────────────
// Builds the instruction text for one batch of jobs. Kept as its
// own function so wording tweaks don't require touching request logic.
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

// ── The actual AI call ───────────────────────────────────────────
// Sends one batch of jobs to /ai on your server.js, which forwards
// to DeepSeek. The browser never contacts DeepSeek directly.
async function analyseJobBatch(jobs) {
  const prompt = buildPrompt(jobs);

  const res = await fetch(AI_CONFIG.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('Could not parse AI response as JSON');
  }
  return parsed.jobs || [];
}

// ── Batch orchestration ──────────────────────────────────────────
// Splits all jobs into numBatches and fires them all in parallel.
// No stagger delay needed — DeepSeek's rate limits are generous
// enough that 4 simultaneous requests from one key is fine.
//
// Returns: { byJobId: Map, byCompany: Map, errors: string[] }
export async function runBatchedAnalysis(allJobs, numBatches = BATCH_CONFIG.numBatches) {
  const batchSize = Math.ceil(allJobs.length / numBatches);
  const batches = [];
  for (let i = 0; i < allJobs.length; i += batchSize) {
    batches.push(allJobs.slice(i, i + batchSize));
  }
  const nonEmptyBatches = batches.filter(b => b.length);

  const settled = await Promise.allSettled(
    nonEmptyBatches.map(batchJobs => analyseJobBatch(batchJobs))
  );

  const byJobId = new Map();
  const byCompany = new Map();
  const errors = [];

  settled.forEach((res, i) => {
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
      errors.push(`Batch ${i + 1} failed: ${msg}`);
      console.warn(`[Analysis batch ${i + 1}]`, msg);
    }
  });

  return { byJobId, byCompany, errors };
}
