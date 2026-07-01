// ════════════════════════════════════════════════════════════════
// CONFIG — every value you might want to tweak lives here.
// Nothing in this file *does* anything — it only holds settings that
// the other files read. If you're looking for a number or string to
// change, look here first before hunting through the logic files.
// ════════════════════════════════════════════════════════════════

// ── Backend server location ────────────────────────────────────
// Auto-detects local vs deployed and points at the right backend.
// Update DEPLOYED_API_URL if your Render backend URL changes.
const DEPLOYED_API_URL = 'https://job-intelligence.onrender.com';
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
export const API = isLocal ? 'http://localhost:3131' : DEPLOYED_API_URL;

// ── AI provider settings ───────────────────────────────────────
// To switch AI providers, update this block + the /ai route in
// server.js. Nothing else in the codebase knows which provider
// is in use.
//
// NOTE: The API key is NO LONGER stored in the browser.
// It lives as an environment variable on the server (DEEPSEEK_API_KEY
// on Render). This is more secure — the key is never exposed to
// the browser at all.
export const AI_CONFIG = {
  // The /ai route on your own server.js — server forwards to DeepSeek.
  // This is why CORS is no longer a problem: browser → your server → DeepSeek.
  endpoint: `${API}/ai`,
  model: 'deepseek-v4-flash',
  displayName: 'DeepSeek V4 Flash', // shown in the settings popover — update when switching providers
  temperature: 0.2,
  maxTokens: 32000,
};

// ── Batch analysis behaviour ───────────────────────────────────
// numBatches controls how many parallel AI calls per search.
// DeepSeek has generous rate limits so no stagger delay is needed —
// all batches fire at once. Change numBatches to 2 or 1 to experiment
// with fewer calls (more jobs per batch, slightly higher failure risk).
export const BATCH_CONFIG = {
  numBatches: 6,
};

// ── Search result limits ───────────────────────────────────────
export const RESULT_LIMITS = {
  maxJobsPerSearch: 24,
  maxCompaniesForLevelsLookup: 8,
  maxSkillsDisplayed: 16,
  maxTagsInPrompt: 5,
};

// ── Display / formatting ───────────────────────────────────────
export const DISPLAY_CONFIG = {
  inrPerUsd: 93,
  lakhDivisor: 100000,
  newBadgeHours: 24,
  dateLocale: 'en-IN',
};

// ── Skill category colours (used in the Skills tab pills/bars) ──
export const CAT = {
  domain:    { bg: '#E1F5EE', c: '#085041', b: '#9FE1CB', bar: '#1D9E75' },
  technical: { bg: '#EEEDFE', c: '#3C3489', b: '#CECBF6', bar: '#7F77DD' },
  soft:      { bg: '#FAEEDA', c: '#633806', b: '#FAC775', bar: '#BA7517' },
  tool:      { bg: '#FAECE7', c: '#712B13', b: '#F5C4B3', bar: '#993C1D' },
};
