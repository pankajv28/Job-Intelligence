// ════════════════════════════════════════════════════════════════
// RENDER — takes data (jobs, AI analysis, company info) and turns it
// into what you see on screen. Every function here either formats a
// small piece of data for display, or writes HTML into the page.
// Nothing in this file fetches data or talks to the AI — it only
// ever receives data as arguments and displays it.
// ════════════════════════════════════════════════════════════════
import { CAT, DISPLAY_CONFIG } from './config.js';
import { SOURCE_LABELS } from './sources.js';

// ── Small formatting helpers ─────────────────────────────────────
export function cs(cat) { return CAT[cat] || CAT.domain; }

export function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(DISPLAY_CONFIG.dateLocale, { day: 'numeric', month: 'short' }); }
  catch { return ''; }
}

export function fmtUSD(j) {
  if (j.salary && /\$|\d/.test(j.salary)) return j.salary.replace(/per year|\/yr|annually/gi, '').trim().slice(0, 30);
  if (j.salaryMin) return `$${Math.round(j.salaryMin / 1000)}k${j.salaryMax && j.salaryMax !== j.salaryMin ? '–$' + Math.round(j.salaryMax / 1000) + 'k' : ''}`;
  return null;
}

export function fmtINR(j) {
  if (!j.salaryMin) return '';
  const { inrPerUsd, lakhDivisor } = DISPLAY_CONFIG;
  const mn = Math.round(j.salaryMin * inrPerUsd / lakhDivisor);
  const mx = j.salaryMax && j.salaryMax !== j.salaryMin ? `–₹${Math.round(j.salaryMax * inrPerUsd / lakhDivisor)}L` : '';
  return `₹${mn}L${mx}`;
}

export function srcBadgeClass(source) {
  const m = { 'Remote OK': 'remoteok', 'Himalayas': 'himalayas', 'We Work Remotely': 'wwr' };
  return m[source] || '';
}

// "New" = posted within the configured window (default 24h)
export function isNew(j) {
  if (!j.postedAt) return false;
  const t = new Date(j.postedAt).getTime();
  return !isNaN(t) && (Date.now() - t) <= DISPLAY_CONFIG.newBadgeHours * 60 * 60 * 1000;
}

// ── HTML sanitizing for job descriptions ─────────────────────────
// Preserves a small whitelist of structural tags (paragraphs, lists,
// emphasis) instead of flattening everything to plain text. Every
// attribute is stripped from every element, so a malicious
// href="javascript:..." or onclick="..." from a third-party job
// posting can never survive into the rendered page. Anything not on
// the whitelist is unwrapped to its text content rather than dropped,
// so real description content isn't lost.
const SAFE_DESCRIPTION_TAGS = new Set(['P', 'UL', 'OL', 'LI', 'BR', 'STRONG', 'EM', 'B', 'I', 'H1', 'H2', 'H3', 'H4']);

export function sanitizeDescriptionHtml(html) {
  const container = document.createElement('div');
  container.innerHTML = html || '';

  function clean(node) {
    const children = [...node.childNodes];
    for (const child of children) {
      if (child.nodeType === 3) continue; // text node — nothing to sanitize
      if (child.nodeType !== 1) { child.remove(); continue; } // comments etc — drop entirely
      clean(child); // sanitize descendants first
      if (SAFE_DESCRIPTION_TAGS.has(child.tagName)) {
        [...child.attributes].forEach(attr => child.removeAttribute(attr.name));
      } else {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
      }
    }
  }
  clean(container);
  return container.innerHTML.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>'); // collapse excessive blank lines
}

// ── Source health badge / panel / sidebar counts ─────────────────
export function renderHealthBadge(sourceHealth) {
  const badge = document.getElementById('healthBadge');
  const active = Object.values(sourceHealth).filter(s => !s.skipped);
  const okCount = active.filter(s => s.ok).length;
  const total = active.length;
  badge.style.display = 'inline-block';
  badge.className = 'health-badge ' + (okCount === total ? 'all-ok' : 'some-down');
  badge.textContent = `${okCount === total ? '✓' : '⚠'} ${okCount}/${total} sources active`;
  renderHealthPanel(sourceHealth);
  renderSidebarCounts(sourceHealth);
}

export function renderHealthPanel(sourceHealth) {
  const panel = document.getElementById('healthPanel');
  const order = ['remotive', 'jobicy', 'himalayas', 'remoteok', 'wwr'];
  panel.innerHTML = `<div class="slbl" style="margin-bottom:4px">Source fetch status</div>` +
    order.map(key => {
      const s = sourceHealth[key];
      const label = SOURCE_LABELS[key];
      if (!s || s.skipped) {
        return `<div class="health-row"><i class="health-icon skip">○</i><div style="flex:1"><div class="health-name-row"><span class="health-name">${label}</span><span class="health-count">not selected for this search</span></div></div></div>`;
      }
      if (s.ok) {
        return `<div class="health-row"><i class="health-icon ok">✓</i><div style="flex:1"><div class="health-name-row"><span class="health-name">${label}</span><span class="health-count">${s.count} job${s.count === 1 ? '' : 's'} returned</span></div></div></div>`;
      }
      return `<div class="health-row"><i class="health-icon fail">✗</i><div style="flex:1"><div class="health-name-row"><span class="health-name">${label}</span><span class="health-count">0 jobs</span></div><div class="health-error">${(s.error || 'Unknown error').replace(/</g, '&lt;')}</div></div></div>`;
    }).join('') +
    `<div class="health-footer">Full error details also print to the server.js terminal window.</div>`;
}

export function renderSidebarCounts(sourceHealth) {
  Object.keys(SOURCE_LABELS).forEach(key => {
    const el = document.getElementById('cnt-' + key);
    if (!el) return;
    const s = sourceHealth[key];
    if (!s || s.skipped) { el.textContent = '–'; return; }
    el.textContent = s.ok ? s.count : '✗';
  });
}

// ── Main results render ───────────────────────────────────────────
export function renderAll(jobs, jobAnalysis, companyAnalysis, role, dupesRemoved, levelsData, selectedJobId) {
  document.getElementById('r-title').textContent = role.replace(/\b\w/g, c => c.toUpperCase());

  const withSal = jobs.filter(j => j.salaryMin > 0);
  const avgUSD = withSal.length ? Math.round(withSal.reduce((a, j) => a + j.salaryMin, 0) / withSal.length) : 0;
  document.getElementById('r-stats').innerHTML = `
    <div class="stat"><div class="stat-lbl">📋 Jobs found</div><div class="stat-val">${jobs.length}</div></div>
    ${avgUSD ? `<div class="stat"><div class="stat-lbl">💰 Avg. salary</div><div class="stat-val">$${Math.round(avgUSD / 1000)}k</div></div><div class="stat"><div class="stat-lbl">₹ Avg. in INR</div><div class="stat-val">₹${Math.round(avgUSD * DISPLAY_CONFIG.inrPerUsd / DISPLAY_CONFIG.lakhDivisor)}L</div></div>` : ''}
    <div class="stat"><div class="stat-lbl">🌐 Sources</div><div class="stat-val">${[...new Set(jobs.map(j => j.source))].length}</div></div>
  `;

  renderJobsTab(jobs, selectedJobId);
  renderSkillsTab(jobs, jobAnalysis);

  document.getElementById('results').style.display = 'block';
}

export function renderJobsTab(jobs, selectedJobId) {
  document.getElementById('tab-jobs').innerHTML = jobs.map(j => {
    const sal = fmtUSD(j); const inr = fmtINR(j);
    const badgeClass = srcBadgeClass(j.source);
    const selectedClass = j.id === selectedJobId ? ' selected' : '';
    return `<div class="job-card${selectedClass}" data-job-id="${j.id}" onclick="openPanel('${j.id}')">
      <div class="job-top">
        <div>
          <div class="job-title-row"><span class="jt">${j.title}</span>${isNew(j) ? '<span class="new-badge">New</span>' : ''}<span class="src-badge ${badgeClass}">${j.source}</span></div>
          <div class="jco">${j.company}${j.postedAt ? ' · ' + fmtDate(j.postedAt) : ''}</div>
        </div>
        <div>${sal ? `<div class="j-sal">${sal}</div>` : '<div class="j-no-sal">Salary not listed</div>'}${inr ? `<div class="j-inr">${inr}</div>` : ''}</div>
      </div>
      ${(j.tags || []).length ? `<div>${j.tags.slice(0, 6).map(t => `<span class="jtag">${t}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('') + `<p class="src-note">All listings live from Remotive, Jobicy, Himalayas, Remote OK, and We Work Remotely. Fetched at ${new Date().toLocaleTimeString()}. Himalayas and We Work Remotely data used per their public API / RSS terms — please apply via the original listing.</p>`;
}

// Aggregates per-job skill mentions + deep dives so the Skills tab can
// show "how many of the N jobs mention this skill", computed from
// real per-job data (covering every job that was successfully
// analysed, not capped to a fixed subset).
export function aggregateSkills(jobs, jobAnalysis, maxSkills) {
  const countByName = new Map();
  const diveByName = new Map();

  jobs.forEach(j => {
    const result = jobAnalysis.get(j.id);
    if (!result) return;
    (result.skills || []).forEach(s => {
      const key = (s.name || '').toLowerCase().trim();
      if (!key) return;
      if (countByName.has(key)) {
        countByName.get(key).count++;
      } else {
        countByName.set(key, { name: s.name, category: s.category, count: 1 });
      }
    });
    (result.skillDeepDives || []).forEach(d => {
      const key = (d.name || '').toLowerCase().trim();
      if (key && !diveByName.has(key)) diveByName.set(key, d);
    });
  });

  const skills = [...countByName.values()].sort((a, b) => b.count - a.count).slice(0, maxSkills);
  const skillDeepDives = skills.filter(s => diveByName.has((s.name || '').toLowerCase().trim()))
    .map(s => diveByName.get(s.name.toLowerCase().trim()));
  return { skills, skillDeepDives };
}

export function renderSkillsTab(jobs, jobAnalysis) {
  const analysedCount = jobs.filter(j => jobAnalysis.has(j.id)).length;
  const { skills, skillDeepDives } = aggregateSkills(jobs, jobAnalysis, 16);
  const maxC = Math.max(...skills.map(s => s.count), 1);
  const leg = Object.entries(CAT).map(([cat, c]) => `<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:${c.bg};color:${c.c};border:0.5px solid ${c.b}">${cat}</span>`).join('');

  const diveByName = {};
  skillDeepDives.forEach(d => { diveByName[(d.name || '').toLowerCase().trim()] = d; });

  let firstExpandableIdx = -1;

  const rowsHtml = skills.map((sk, i) => {
    const c = cs(sk.category);
    const dive = diveByName[(sk.name || '').toLowerCase().trim()];
    if (dive && firstExpandableIdx === -1) firstExpandableIdx = i;
    const isFirst = i === firstExpandableIdx;

    const priorityColor = dive && /High ROI/i.test(dive.priority) ? { bg: 'var(--teal-bg)', c: 'var(--teal-d)', b: 'var(--teal-m)' }
      : dive && /leverage/i.test(dive.priority) ? { bg: 'var(--teal-bg)', c: 'var(--teal-d)', b: 'var(--teal-m)' }
      : { bg: 'var(--amb-bg)', c: 'var(--amb-d)', b: 'var(--amb-m)' };
    const stepsHtml = dive ? (dive.steps || []).map((s, si) => `<div class="upskill-step"><div class="upskill-n">${si + 1}</div><div class="upskill-txt">${s.step}<div class="upskill-time">⏱ ${s.time || ''}</div></div></div>`).join('') : '';

    const detailHtml = dive ? `
      <div class="skill-detail${isFirst ? '' : ' hidden'}">
        <div class="skill-what"><strong>What it actually is:</strong> ${dive.what || ''}</div>
        <div class="skill-why"><strong>Why companies want it:</strong> ${dive.why || ''}</div>
        <div class="upskill-path">${stepsHtml}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:0.5px solid var(--border)">
          <span style="font-size:11px;padding:2px 10px;border-radius:20px;border:0.5px solid var(--border2);background:var(--bg)">⏱ ${dive.totalTime || ''}</span>
          <span style="font-size:11px;padding:2px 10px;border-radius:20px;background:${priorityColor.bg};color:${priorityColor.c};border:0.5px solid ${priorityColor.b}">${dive.priority || ''}</span>
        </div>
      </div>` : '';

    return `<div class="skill-block">
      <div class="skill-row${dive ? ' clickable' : ''}" ${dive ? 'onclick="toggleSkillRow(this)"' : ''}>
        <div class="skill-name">${sk.name}<span class="cpill" style="background:${c.bg};color:${c.c};border:0.5px solid ${c.b}">${sk.category}</span></div>
        <div class="skill-track"><div class="skill-fill" style="width:${Math.round((sk.count / maxC) * 100)}%;background:${c.bar}"></div></div>
        <div class="skill-n">${sk.count}/${analysedCount}</div>
        ${dive ? `<span class="chevron${isFirst ? ' open' : ''}">▼</span>` : '<span style="width:14px;display:inline-block"></span>'}
      </div>
      ${detailHtml}
    </div>`;
  }).join('');

  const coverageNote = analysedCount < jobs.length
    ? `${analysedCount} of ${jobs.length} listings (some analysis batches may have failed — see status message above)`
    : `all ${analysedCount} listings`;

  document.getElementById('tab-skills').innerHTML = `
    <div class="slbl">Extracted from ${coverageNote}, read individually</div>
    <div class="legend">${leg}</div>
    ${rowsHtml || '<p style="color:var(--text3);font-size:13px">No skills extracted yet.</p>'}
    <p class="src-note">Each job's description was analysed on its own, then combined here. Click a skill with a deep dive available to see what it actually involves and how to upskill.</p>`;
}

// ── Detail panel ───────────────────────────────────────────────
// Reads from the per-job batched analysis and per-company cache
// passed in as arguments — every job gets its own real skills +
// company analysis, not a shared aggregate. If a job's batch failed,
// the relevant section says so instead of guessing.
export function renderPanel(job, activeTab, jobAnalysis, companyAnalysis, levelsData) {
  const initials = (job.company || '?').trim().slice(0, 2).toUpperCase();
  const sal = fmtUSD(job); const inr = fmtINR(job);

  const tabsHtml = ['overview', 'skills', 'salary', 'company'].map(t => {
    const labels = { overview: 'Overview', skills: 'Skills', salary: 'Salary Insight', company: 'Company' };
    return `<div class="panel-tab${t === activeTab ? ' active' : ''}" onclick="showPanelTab('${job.id}','${t}')">${labels[t]}</div>`;
  }).join('');

  let bodyHtml = '';
  if (activeTab === 'overview') {
    const safeDescHtml = sanitizeDescriptionHtml(job.description);
    bodyHtml = `
      <div class="panel-section-head">Job description</div>
      <div class="job-desc-html">${safeDescHtml || '<p>No description provided by the source.</p>'}</div>
      ${(job.tags || []).length ? `<div class="panel-section-head">Tags</div><div>${job.tags.map(t => `<span class="skill-pill">${t}</span>`).join('')}</div>` : ''}
    `;
  } else if (activeTab === 'skills') {
    const jobResult = jobAnalysis.get(job.id);
    if (!jobResult) {
      bodyHtml = `
        <div class="panel-section-head">Tags on this listing</div>
        <div>${(job.tags || []).length ? job.tags.map(t => `<span class="skill-pill">${t}</span>`).join('') : '<span style="color:var(--text3)">No tags provided by the source.</span>'}</div>
        <p style="font-size:12px;color:var(--text3);margin-top:10px">This job wasn't analysed (its batch may have failed — try searching again).</p>`;
    } else {
      const skills = jobResult.skills || [];
      bodyHtml = `
        <div class="panel-section-head">Skills required for this role</div>
        <div>${skills.length ? skills.map(s => `<span class="skill-pill">${s.name}</span>`).join('') : '<span style="color:var(--text3)">No specific skills extracted from this description.</span>'}</div>
        ${(jobResult.skillDeepDives || []).length ? `<div class="panel-section-head">Skill deep dive</div>` + jobResult.skillDeepDives.map(d => {
          const stepsHtml = (d.steps || []).map((s, si) => `<div class="upskill-step"><div class="upskill-n">${si + 1}</div><div class="upskill-txt">${s.step}<div class="upskill-time">⏱ ${s.time || ''}</div></div></div>`).join('');
          return `<div class="insight-card">
            <div class="insight-card-head"><strong style="color:var(--text)">${d.name}</strong><span style="font-size:11px;color:var(--text3)">${d.category || ''}</span></div>
            <div style="margin-bottom:8px"><strong>What:</strong> ${d.what || ''}</div>
            <div style="font-size:12px;margin-bottom:8px"><strong>Why:</strong> ${d.why || ''}</div>
            <div class="upskill-path">${stepsHtml}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:8px">⏱ ${d.totalTime || ''} · ${d.priority || ''}</div>
          </div>`;
        }).join('') : ''}
        ${(job.tags || []).length ? `<div class="panel-section-head">Source tags</div><div>${job.tags.map(t => `<span class="skill-pill">${t}</span>`).join('')}</div>` : ''}
      `;
    }
  } else if (activeTab === 'salary') {
    const jobResult = jobAnalysis.get(job.id);
    const lv = (levelsData || {})[job.company];
    let levelsBlock = '';
    if (lv && lv.roles && lv.roles.length) {
      levelsBlock = `<div class="panel-section-head">From Levels.fyi</div>` +
        lv.roles.slice(0, 4).map(r => `<div class="sal-levels-row"><span class="l-name">${r.role}</span><span class="l-val">${r.figures.join(' · ')}</span></div>`).join('');
    } else {
      levelsBlock = `<p style="font-size:12px;color:var(--text3);margin-top:10px">No Levels.fyi data found for ${job.company} — showing listing salary only.</p>`;
    }
    bodyHtml = `
      <div class="insight-card">
        <div class="insight-card-head"><span>Salary insight</span><span>💰</span></div>
        ${sal ? `<div style="font-size:16px;font-weight:700;color:var(--teal)">${sal}</div>${inr ? `<div style="font-size:12px;margin-top:2px">${inr} <span style="color:var(--text3)">(indicative, ₹${DISPLAY_CONFIG.inrPerUsd}/$)</span></div>` : ''}` : '<div>Salary not listed for this role. No figure available from the listing.</div>'}
      </div>
      ${levelsBlock}
      <p class="src-note" style="margin-top:14px">${(jobResult && jobResult.salaryNote) || 'Salary pulled from listing fields, not estimated.'} Levels.fyi figures sourced from their public company salary pages, used with attribution per their terms.</p>
    `;
  } else if (activeTab === 'company') {
    const companyKey = (job.company || '').toLowerCase().trim();
    const co = companyAnalysis.get(companyKey);
    if (co) {
      const targetItems = (co.targetMarket || []).map(t => {
        const isCaution = /^caution:/i.test(t);
        return `<div class="intel-item ${isCaution ? 'caution' : 'positive'}">${t.replace(/^caution:\s*/i, '')}</div>`;
      }).join('');
      const growthItems = (co.growth || []).map(g => {
        const isDown = /\bdown\b|\bdeclin|\blay-?off/i.test(g);
        const arrow = isDown ? '↓' : '↑';
        return `<div class="intel-item ${isDown ? 'caution' : 'positive'}">${arrow} ${g}</div>`;
      }).join('');
      const unknownStage = !co.stage || co.stage === 'unknown';
      bodyHtml = `
        <div class="company-tagline">${co.tagline || ''}</div>
        ${!unknownStage ? `<span style="font-size:11px;padding:2px 10px;border-radius:20px;border:0.5px solid var(--border2);background:var(--bg2)">${co.stage}</span>` : ''}
        ${targetItems ? `<div class="intel-section-head">Target market</div>${targetItems}` : ''}
        ${growthItems ? `<div class="intel-section-head">Growth (last 2 years)</div>${growthItems}` : ''}
      `;
    } else {
      bodyHtml = `<p style="font-size:12px;color:var(--text3);margin-top:6px">This job wasn't analysed (its batch may have failed — try searching again).</p>`;
    }
  }

  document.getElementById('panel-content').innerHTML = `
    <div class="panel-head">
      <div>
        <div class="panel-co-logo">${initials}</div>
        <div class="panel-title">${job.title}</div>
        <div class="panel-sub"><span>${job.company}</span><span>·</span><span>📍 Remote</span>${job.postedAt ? `<span>·</span><span>🕒 ${fmtDate(job.postedAt)}</span>` : ''}</div>
      </div>
      <button class="panel-close" onclick="closePanel()">✕</button>
    </div>
    <div class="panel-actions">
      ${job.url ? `<a class="btn-apply" href="${job.url}" target="_blank">Apply on website ↗</a>` : '<span class="btn-apply" style="opacity:.5;cursor:default">No application link</span>'}
    </div>
    <div class="panel-tabs">${tabsHtml}</div>
    <div class="panel-section">${bodyHtml}</div>
    <div class="source-line"><span>Source: ${job.source}</span></div>
  `;
}

export function toggleSkillRow(row) {
  const block = row.parentElement;
  const detail = block.querySelector('.skill-detail');
  if (!detail) return;
  const chevron = row.querySelector('.chevron');
  const isOpen = !detail.classList.contains('hidden');

  document.querySelectorAll('#tab-skills .skill-detail').forEach(d => d.classList.add('hidden'));
  document.querySelectorAll('#tab-skills .chevron').forEach(c => c.classList.remove('open'));

  if (!isOpen) {
    detail.classList.remove('hidden');
    if (chevron) chevron.classList.add('open');
  }
}
