// ════════════════════════════════════════════════════════════════
// APP — the conductor. Holds the app's state (the last search
// results), wires up the page's buttons and controls, and runs the
// search: fetch from sources → analyse with AI → render to screen.
// This file calls into sources.js, ai.js, and render.js but contains
// no fetching/AI/rendering logic of its own.
// ════════════════════════════════════════════════════════════════
import { API, BATCH_CONFIG, RESULT_LIMITS, AI_CONFIG } from './config.js';
import { SOURCE_FETCHERS, SOURCE_LABELS, isRelevantToSearch, fetchLevelsData } from './sources.js';
import { runBatchedAnalysis } from './ai.js';
import { renderAll, renderHealthBadge, renderPanel, toggleSkillRow as renderToggleSkillRow } from './render.js';

// ── App state ─────────────────────────────────────────────────
// Kept here (not in render.js) so render.js stays a "pure" data-in,
// screen-out file. Search-result state is kept so sort/filter
// changes can re-render without refetching.
let activeSources = new Set(['remotive', 'jobicy', 'himalayas', 'remoteok', 'wwr']);
let lastSourceHealth = null;
let lastJobs = [];
let lastJobAnalysis = new Map();
let lastCompanyAnalysis = new Map();
let lastAnalysisErrors = [];
let lastLevelsData = {};
let lastRole = '';
let lastDupesRemoved = 0;
let selectedJobId = null;
let serverOk = null; // null = unknown/checking, so the first successful check isn't treated as a "reconnect"

// ── Theme ────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeToggle').textContent = t === 'dark' ? '🌙' : '☀️';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}
(function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved) { applyTheme(saved); }
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) { applyTheme('dark'); }
})();

// ── Populate AI provider name in settings from config ────────────
// This keeps index.html provider-agnostic — only config.js needs
// updating when switching AI providers.
document.querySelector('#settingsPop .note').textContent =
  `AI analysis is powered by ${AI_CONFIG.displayName}, running server-side. No API key needed here — it's configured on the server.`;

// ── Sidebar collapse ─────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  document.getElementById('shell').classList.toggle('sidebar-collapsed');
}

// ── Settings popover ─────────────────────────────────────────
function toggleSettings() {
  document.getElementById('settingsPop').classList.toggle('open');
}
document.addEventListener('click', (e) => {
  const pop = document.getElementById('settingsPop');
  const btn = document.getElementById('settingsBtn');
  if (pop.classList.contains('open') && !pop.contains(e.target) && e.target !== btn) {
    pop.classList.remove('open');
  }
});

// ── Server check ─────────────────────────────────────────────
function setServerBadge(state) {
  const badge = document.getElementById('serverBadge');
  if (state === 'checking') {
    badge.className = 'health-badge';
    badge.textContent = 'Checking server...';
  } else if (state === 'ok') {
    badge.className = 'health-badge all-ok';
    badge.textContent = '✓ Server';
  } else {
    badge.className = 'health-badge some-down';
    badge.textContent = '⚠ Server not running';
  }
}

function showToast(state) {
  const toast = document.getElementById('serverToast');
  if (state === 'err') {
    toast.className = 'server-toast show err';
    toast.innerHTML = '⚠ Server connection lost — start it with <code>node server.js</code>';
    requestAnimationFrame(() => toast.classList.add('visible'));
  } else {
    toast.className = 'server-toast show ok';
    toast.innerHTML = '✓ Server reconnected';
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => { toast.className = 'server-toast'; }, 320);
    }, 2500);
  }
}
function hideToast() {
  const toast = document.getElementById('serverToast');
  toast.classList.remove('visible');
  setTimeout(() => { toast.className = 'server-toast'; }, 320);
}

async function checkServer() {
  if (serverOk === null) setServerBadge('checking');
  let nowOk = false;
  try {
    const res = await fetch(API + '/health', { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    nowOk = !!data.ok;
  } catch (e) { nowOk = false; }

  const wasOk = serverOk;
  serverOk = nowOk;
  setServerBadge(nowOk ? 'ok' : 'err');

  if (nowOk) {
    if (wasOk === false) showToast('ok');
    else if (wasOk === null) hideToast();
  } else {
    if (wasOk === true || wasOk === null) showToast('err');
  }
}
checkServer();
setInterval(checkServer, 3000);

// ── Source toggles ──────────────────────────────────────────
function toggleSrc(rowEl) {
  const src = rowEl.dataset.src;
  const check = rowEl.querySelector('.src-check');
  if (activeSources.has(src)) {
    if (activeSources.size === 1) return; // keep at least one source on
    activeSources.delete(src);
    check.classList.remove('on');
    check.textContent = '';
  } else {
    activeSources.add(src);
    check.classList.add('on');
    check.textContent = '✓';
  }
}

// ── Tabs (Jobs / Skills Analysis) ──────────────────────────────
function showTab(name, el) {
  ['jobs', 'skills'].forEach(t =>
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none');
  document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

// ── Status line ──────────────────────────────────────────────
function setStatus(msg, loading, isErr) {
  const statusEl = document.getElementById('status');
  let msgSpan = statusEl.querySelector('.status-msg');
  if (!msgSpan) {
    msgSpan = document.createElement('span');
    msgSpan.className = 'status-msg';
    statusEl.insertBefore(msgSpan, statusEl.firstChild);
  }
  msgSpan.innerHTML = (loading ? '<div class="spinner" style="display:inline-block;vertical-align:middle;margin-right:6px"></div>' : '') + `<span class="${isErr ? 'err' : ''}">${msg}</span>`;
}

// ── Source health panel toggle ──────────────────────────────────
function toggleHealthPanel() {
  const panel = document.getElementById('healthPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

// ── Detail panel open/close/tab switch ──────────────────────────
function openPanel(jobId) {
  const job = lastJobs.find(j => j.id === jobId);
  if (!job) return;
  selectedJobId = jobId;
  document.querySelectorAll('.job-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.jobId === jobId);
  });
  renderPanel(job, 'overview', lastJobAnalysis, lastCompanyAnalysis, lastLevelsData);
  document.getElementById('panel').classList.add('open');
}
function closePanel() {
  selectedJobId = null;
  document.getElementById('panel').classList.remove('open');
  document.querySelectorAll('.job-card').forEach(c => c.classList.remove('selected'));
}
function showPanelTab(jobId, tab) {
  const job = lastJobs.find(j => j.id === jobId);
  if (!job) return;
  renderPanel(job, tab, lastJobAnalysis, lastCompanyAnalysis, lastLevelsData);
}
function toggleSkillRow(row) { renderToggleSkillRow(row); }

// ── Main search ───────────────────────────────────────────────
async function runSearch() {
  if (!serverOk) { setStatus('Start the local server first (see instructions above).', false, true); return; }

  const role = document.getElementById('role').value.trim() || 'product manager';
  const sources = [...activeSources];

  document.getElementById('searchBtn').disabled = true;
  document.getElementById('results').style.display = 'none';
  closePanel();

  let allJobs = [];
  const jobsBySource = {};
  const errors = [];
  const sourceHealth = {};

  setStatus(`Fetching from ${sources.map(s => SOURCE_LABELS[s]).join(', ')}...`, true);
  const settled = await Promise.allSettled(sources.map(s => SOURCE_FETCHERS[s](role)));
  settled.forEach((res, i) => {
    const srcKey = sources[i];
    if (res.status === 'fulfilled') {
      const relevant = res.value.filter(j => isRelevantToSearch(j, role));
      jobsBySource[srcKey] = relevant;
      sourceHealth[srcKey] = { ok: true, count: relevant.length, error: null };
    } else {
      const msg = res.reason?.message || 'Unknown error';
      errors.push(`${SOURCE_LABELS[srcKey]} failed: ${msg}`);
      sourceHealth[srcKey] = { ok: false, count: 0, error: msg };
      console.warn(`[${SOURCE_LABELS[srcKey]}]`, msg);
    }
  });
  Object.keys(SOURCE_LABELS).forEach(s => {
    if (!sourceHealth[s]) sourceHealth[s] = { ok: null, count: 0, error: null, skipped: true };
  });
  lastSourceHealth = sourceHealth;
  renderHealthBadge(sourceHealth);

  // Interleave round-robin across sources so a high-volume source
  // doesn't fill the entire cap before other sources get a turn.
  const sourceKeys = Object.keys(jobsBySource);
  const maxLen = Math.max(0, ...sourceKeys.map(s => jobsBySource[s].length));
  for (let i = 0; i < maxLen; i++) {
    for (const s of sourceKeys) {
      if (jobsBySource[s][i]) allJobs.push(jobsBySource[s][i]);
    }
  }

  // Dedupe across sources by normalised title+company
  const seen = new Set();
  const beforeDedupe = allJobs.length;
  allJobs = allJobs.filter(j => {
    const k = `${j.title}|||${j.company}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const dupesRemoved = beforeDedupe - allJobs.length;

  const finalJobs = allJobs.slice(0, RESULT_LIMITS.maxJobsPerSearch);

  if (!finalJobs.length) {
    const errNote = errors.length ? ` Sources with errors: ${errors.join('; ')}` : '';
    setStatus('No jobs found. Try a broader keyword first to confirm APIs are working.' + errNote, false, true);
    document.getElementById('searchBtn').disabled = false;
    return;
  }

  setStatus(`${finalJobs.length} real listings (${dupesRemoved} duplicates removed). Analysing each job (${BATCH_CONFIG.numBatches} parallel batches)...`, true);
  let byJobId, byCompany, analysisErrors;
  try {
    const result = await runBatchedAnalysis(finalJobs, BATCH_CONFIG.numBatches);
    byJobId = result.byJobId; byCompany = result.byCompany; analysisErrors = result.errors;
    if (byJobId.size === 0) {
      throw new Error(analysisErrors[0] || 'All analysis batches failed');
    }
  } catch (e) {
    setStatus('AI provider error: ' + e.message, false, true);
    document.getElementById('searchBtn').disabled = false;
    return;
  }

  setStatus(`Fetching Levels.fyi salary benchmarks...`, true);
  const companiesForLevels = [...new Set(finalJobs.map(j => j.company).filter(Boolean))].slice(0, RESULT_LIMITS.maxCompaniesForLevelsLookup);
  const levelsData = {};
  await Promise.all(companiesForLevels.map(async c => {
    const d = await fetchLevelsData(c);
    if (d) levelsData[c] = d;
  }));

  // Stash full state for sort/filter re-renders that don't need a refetch
  lastJobs = finalJobs;
  lastJobAnalysis = byJobId;
  lastCompanyAnalysis = byCompany;
  lastAnalysisErrors = analysisErrors;
  lastLevelsData = levelsData;
  lastRole = role;
  lastDupesRemoved = dupesRemoved;
  selectedJobId = null;

  applyFiltersAndRender();
  const batchNote = analysisErrors.length ? ` · ⚠ ${analysisErrors.length} of ${BATCH_CONFIG.numBatches} analysis batches failed (${lastJobAnalysis.size}/${finalJobs.length} jobs analysed)` : '';
  setStatus(`Done — ${finalJobs.length} real listings · ${dupesRemoved} duplicates removed · Skills from actual job text${batchNote}`, false, analysisErrors.length > 0);
  document.getElementById('searchBtn').disabled = false;
}

// ── Sort + date filter (re-render from cached state, no refetch) ──
function applyFiltersAndRender() {
  if (!lastJobs.length) return;

  const days = parseInt(document.getElementById('dateFilter').value) || 0;
  let jobs = lastJobs;
  if (days > 0) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    jobs = jobs.filter(j => {
      if (!j.postedAt) return false;
      const t = new Date(j.postedAt).getTime();
      return !isNaN(t) && t >= cutoff;
    });
  }

  const sortBy = document.getElementById('sortSelect').value;
  jobs = [...jobs];
  if (sortBy === 'salary') {
    jobs.sort((a, b) => (b.salaryMin || 0) - (a.salaryMin || 0));
  } else {
    jobs.sort((a, b) => {
      const ta = a.postedAt ? new Date(a.postedAt).getTime() : 0;
      const tb = b.postedAt ? new Date(b.postedAt).getTime() : 0;
      return tb - ta;
    });
  }

  renderAll(jobs, lastJobAnalysis, lastCompanyAnalysis, lastRole, lastDupesRemoved, lastLevelsData, selectedJobId);
}

// ── Expose functions the HTML's inline onclick/oninput attributes
// need to find. Everything else stays module-private. ────────────
Object.assign(window, {
  toggleTheme, toggleSidebar, toggleSettings, toggleSrc,
  showTab, toggleHealthPanel,
  openPanel, closePanel, showPanelTab, toggleSkillRow,
  runSearch, applyFiltersAndRender,
});
