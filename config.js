// ════════════════════════════════════════════════════════════════
// CONFIG — every value you might want to tweak lives here.
// Nothing in this file *does* anything — it only holds settings that
// the other files read. If you're looking for a number or string to
// change, look here first before hunting through the logic files.
// ════════════════════════════════════════════════════════════════

// ── Backend server location ────────────────────────────────────
// Auto-detects whether this page is running locally (file:// or
// localhost, as during development) or as the deployed static site —
// and points at the matching backend accordingly. Update
// DEPLOYED_API_URL once you have your actual Render backend URL.
const DEPLOYED_API_URL = 'https://job-intelligence.onrender.com';
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
export const API = isLocal ? 'http://localhost:3131' : DEPLOYED_API_URL;

// ── AI provider settings ───────────────────────────────────────
// This is the block you change when switching AI providers (e.g.
// away from Groq). Everything here describes WHAT to call and HOW —
// the actual calling code lives in ai.js and never hardcodes these
// values itself.
export const AI_CONFIG = {
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.2,
  maxTokens: 7000,
  // localStorage key names used to store the user's API key(s)
  keyStorageName: 'groq_key',
  key2StorageName: 'groq_key2',
  // The key must start with this prefix, or runSearch() will refuse
  // to use it (sanity check before burning a request). Set to ''
  // to disable this check entirely for a different provider.
  keyPrefix: 'gsk_',
};

// ── Batch analysis behaviour ───────────────────────────────────
export const BATCH_CONFIG = {
  numBatches: 4,                  // how many parallel AI calls per search
  defaultStaggerSeconds: 3,       // delay between a single key's own batches
  maxStaggerSeconds: 60,          // upper bound allowed in the settings UI
};

// ── Search result limits ───────────────────────────────────────
export const RESULT_LIMITS = {
  maxJobsPerSearch: 24,           // total jobs analysed per search, across all sources
  maxCompaniesForLevelsLookup: 8, // how many companies get a Levels.fyi salary check
  maxSkillsDisplayed: 16,         // top-N skills shown in the Skills tab
  maxTagsInPrompt: 5,             // how many of a job's tags get sent to the AI
};

// ── Display / formatting ───────────────────────────────────────
export const DISPLAY_CONFIG = {
  inrPerUsd: 93,                  // USD → INR conversion rate used for salary display
  lakhDivisor: 100000,            // 1 lakh = 100,000 — used to format INR as "₹12L"
  newBadgeHours: 24,               // a job counts as "New" if posted within this many hours
  dateLocale: 'en-IN',
};

// ── Skill category colours (used in the Skills tab pills/bars) ──
export const CAT = {
  domain:    { bg: '#E1F5EE', c: '#085041', b: '#9FE1CB', bar: '#1D9E75' },
  technical: { bg: '#EEEDFE', c: '#3C3489', b: '#CECBF6', bar: '#7F77DD' },
  soft:      { bg: '#FAEEDA', c: '#633806', b: '#FAC775', bar: '#BA7517' },
  tool:      { bg: '#FAECE7', c: '#712B13', b: '#F5C4B3', bar: '#993C1D' },
};
