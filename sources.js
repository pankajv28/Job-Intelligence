// ════════════════════════════════════════════════════════════════
// SOURCES — everything about talking to job boards lives here.
// Each board has: an id, a display label, and a fetch function that
// asks our backend proxy for jobs and translates the response into
// our standard job shape: {id, title, company, salary, salaryMin,
// salaryMax, url, description, tags, source, postedAt}.
//
// To add or remove a job board, this is the only file you touch:
// write a fetchX() function, then add one line each to
// SOURCE_FETCHERS and SOURCE_LABELS below.
// ════════════════════════════════════════════════════════════════
import { API } from './config.js';

// ── Generic JSON fetch, used by every source below ─────────────
async function fetchJSON(url) {
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || d.error) {
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return d;
}

// ── Salary string parsing ───────────────────────────────────────
// Pulls plausible dollar figures out of a free-text salary string
// (e.g. Remotive's "$90,000 - $120,000"). Filters out small numbers
// that are probably not salaries, and scales up shorthand like "90"
// meaning "90k" if it's clearly too small to be an actual salary.
export function parseSalStr(s) {
  if (!s) return { min: 0, max: 0 };
  const nums = [...s.matchAll(/[\d,]+/g)].map(m => parseInt(m[0].replace(/,/g, ''))).filter(n => n > 500);
  if (!nums.length) return { min: 0, max: 0 };
  const scaled = nums.map(n => n < 5000 ? n * 1000 : n);
  return { min: Math.min(...scaled), max: Math.max(...scaled) };
}

// ── Company name → Levels.fyi URL slug ──────────────────────────
function toSlug(name) {
  return (name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ── Relevance filter ─────────────────────────────────────────────
// Applied uniformly to every source's results, regardless of whether
// that source's own API does its own (often loose/unreliable) search
// matching. A job passes only if every word from the search query
// appears in the job's TITLE specifically — not buried somewhere in
// a long description, which is how "Account Coordinator" used to
// slip through a "product manager" search (the words happened to
// appear separately, somewhere in the description, without the job
// having anything to do with product management).
export function isRelevantToSearch(job, role) {
  const terms = (role || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true; // no search term to filter by — keep everything
  const title = (job.title || '').toLowerCase();
  return terms.every(t => title.includes(t));
}

// ── Individual source fetchers ──────────────────────────────────

async function fetchRemotive(role) {
  const params = new URLSearchParams({ search: role });
  const d = await fetchJSON(`${API}/remotive?${params}`);
  return (d.jobs || []).map(j => ({
    id: 'remotive_' + j.id, title: j.title || '', company: j.company_name || '',
    salary: j.salary || '', salaryMin: parseSalStr(j.salary).min, salaryMax: parseSalStr(j.salary).max,
    url: j.url || '', description: j.description || '', tags: j.tags || [], source: 'Remotive', postedAt: j.publication_date || ''
  }));
}

async function fetchJobicy(role) {
  // Jobicy's tag param is free-text search against job title/description
  // (their own docs only ever show single plain words like tag=python or
  // tag=seo — never a hyphenated compound). Sending "product-manager" as
  // one fused token matched nothing, which is why multi-word searches
  // always returned 0 results here. Send the natural phrase instead.
  const tag = role.toLowerCase().trim();
  const d = await fetchJSON(`${API}/jobicy?tag=${encodeURIComponent(tag)}`);
  return (d.jobs || []).map(j => ({
    id: 'jobicy_' + j.id, title: j.jobTitle || '', company: j.companyName || '',
    salary: j.annualSalaryMin ? `$${Math.round(j.annualSalaryMin / 1000)}k–$${Math.round((j.annualSalaryMax || j.annualSalaryMin) / 1000)}k` : '',
    salaryMin: j.annualSalaryMin || 0, salaryMax: j.annualSalaryMax || j.annualSalaryMin || 0,
    url: j.url || '', description: j.jobDescription || j.jobExcerpt || '',
    tags: [...(j.jobIndustry || []), ...(j.jobType || [])], source: 'Jobicy', postedAt: j.pubDate || ''
  }));
}

async function fetchHimalayas(role) {
  const d = await fetchJSON(`${API}/himalayas?search=${encodeURIComponent(role)}&limit=20`);
  return (d.jobs || []).map((j, i) => ({
    id: 'himalayas_' + (j.guid || i), title: j.title || '', company: j.companyName || '',
    salary: j.minSalary ? `$${Math.round(j.minSalary / 1000)}k${j.maxSalary && j.maxSalary !== j.minSalary ? '–$' + Math.round(j.maxSalary / 1000) + 'k' : ''}` : '',
    salaryMin: j.minSalary || 0, salaryMax: j.maxSalary || j.minSalary || 0,
    url: j.applicationLink || '', description: j.description || j.excerpt || '',
    tags: [...(j.categories || []), ...(j.seniority || [])], source: 'Himalayas', postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : ''
  }));
}

async function fetchRemoteOK(role) {
  const d = await fetchJSON(`${API}/remoteok?search=${encodeURIComponent(role)}`);
  const terms = (role || '').toLowerCase().trim().split(/\s+/).filter(Boolean);

  return (d.jobs || []).filter(j => {
    // Remote OK's server already filtered by title+tags+description, so the
    // client-side title-only check would be too strict here — a job tagged
    // "product manager" with title "Growth Lead" is genuinely relevant.
    // Instead we check title OR tags (not description — that's too loose).
    if (!terms.length) return true;
    const title = (j.position || '').toLowerCase();
    const tags = (j.tags || []).join(' ').toLowerCase();
    return terms.every(t => title.includes(t) || tags.includes(t));
  }).map(j => ({
    id: 'remoteok_' + j.id, title: j.position || '', company: j.company || '',
    salary: j.salary_min ? `$${Math.round(j.salary_min / 1000)}k${j.salary_max && j.salary_max !== j.salary_min ? '–$' + Math.round(j.salary_max / 1000) + 'k' : ''}` : '',
    salaryMin: j.salary_min || 0, salaryMax: j.salary_max || j.salary_min || 0,
    url: j.url || j.apply_url || '', description: j.description || '', tags: j.tags || [], source: 'Remote OK', postedAt: j.date || ''
  }));
}

async function fetchWWR(role) {
  const d = await fetchJSON(`${API}/wwr?search=${encodeURIComponent(role)}`);
  return (d.jobs || []).map((j, i) => ({
    id: 'wwr_' + i + '_' + toSlug(j.title), title: j.title || '', company: j.company || '',
    salary: '', salaryMin: 0, salaryMax: 0,
    url: j.url || '', description: j.description || '', tags: j.categories || [], source: 'We Work Remotely', postedAt: j.pubDate || ''
  }));
}

// ── The registry — this is what app.js loops over ───────────────
export const SOURCE_FETCHERS = {
  remotive: (role) => fetchRemotive(role),
  jobicy: (role) => fetchJobicy(role),
  himalayas: (role) => fetchHimalayas(role),
  remoteok: (role) => fetchRemoteOK(role),
  wwr: (role) => fetchWWR(role),
};
export const SOURCE_LABELS = {
  remotive: 'Remotive', jobicy: 'Jobicy', himalayas: 'Himalayas', remoteok: 'Remote OK', wwr: 'We Work Remotely'
};

// ── Levels.fyi salary lookup — fetches the public .md page per company ──
export async function fetchLevelsData(companyName) {
  try {
    const r = await fetch(`${API}/levels?company=${encodeURIComponent(companyName)}`);
    const d = await r.json();
    if (!d.found) return null;
    return parseLevelsMarkdown(d.markdown);
  } catch (e) { return null; }
}

function parseLevelsMarkdown(md) {
  if (!md) return null;
  const result = { roles: [] };
  const lines = md.split('\n');
  let currentRole = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const headingMatch = line.match(/^#{2,4}\s+(.+)/);
    if (headingMatch && !/data|api|license|attribution/i.test(headingMatch[1])) {
      currentRole = headingMatch[1].replace(/\*/g, '').trim();
      continue;
    }
    const moneyMatches = [...line.matchAll(/\$[\d,]+(?:k|K)?/g)].map(m => m[0]);
    if (moneyMatches.length && currentRole) {
      result.roles.push({ role: currentRole, line: line.replace(/\*/g, '').slice(0, 160), figures: moneyMatches.slice(0, 4) });
      currentRole = null;
    }
  }
  result.roles = result.roles.slice(0, 6);
  return result.roles.length ? result : null;
}
