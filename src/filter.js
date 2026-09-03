'use strict';

const config = require('./config');

/**
 * Deterministic pre-filter. Runs BEFORE any AI call so that scoring only ever
 * sees plausible candidates — this is the main cost control and the main
 * tuning surface.
 *
 * Every rejection records a reason, so `filter_reason` on the jobs table
 * explains the funnel rather than leaving jobs silently missing.
 */

// Locations that are explicitly not India-eligible. Written to catch the
// abbreviated forms too: "Remote U.S.", "US Remote", "Remote, USA".
const NON_INDIA_LOCATION = new RegExp(
  [
    'united states', 'u\\.s\\.', '\\bus\\b', '\\busa\\b', 'america',
    'canada', 'toronto', 'vancouver',
    'emea', 'europe', 'united kingdom', '\\buk\\b', 'london', 'ireland',
    'germany', 'berlin', 'poland', 'netherlands', 'amsterdam', 'spain',
    'france', 'paris', 'sweden', 'denmark', 'austria', 'switzerland',
    'australia', 'sydney', 'melbourne', 'singapore', 'japan', 'tokyo',
    'brazil', 'mexico', 'latam',
    'arab', 'dubai', 'uae', 'israel', 'tel aviv',
  ].join('|'),
  'i'
);

const INDIA_LOCATION = new RegExp(
  [
    'india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'gurugram',
    'gurgaon', 'noida', 'delhi', '\\bncr\\b', 'chennai', 'mumbai',
    'kolkata', 'ahmedabad', 'jaipur', 'indore', 'kochi', 'trivandrum',
    'coimbatore', 'chandigarh', 'patiala',
  ].join('|'),
  'i'
);

/**
 * Pulls the minimum years of experience a posting asks for.
 *
 * Deliberately conservative: it returns the LOWEST number found across all
 * matches, because a posting saying "3+ years backend, 5+ years preferred"
 * is still open to a 3-year candidate. Returns null when unstated, and null
 * is treated as a pass — most postings don't state a number, and rejecting
 * them all would gut the funnel.
 */
function extractMinYears(description) {
  if (!description) return null;

  const patterns = [
    // "3+ years", "3-5 years", "3 to 5 years" — the bare form. Postings write
    // "3+ years required" and "3+ years in backend" as often as they write
    // "3+ years of experience", so the word "experience" cannot be required.
    /(\d{1,2})\s*(?:\+|-|–|to)\s*(?:\d{1,2})?\s*\+?\s*years?/gi,
    /(\d{1,2})\s*years?/gi,
    // "experience: 3 years", "minimum 3 years", "at least 3 years"
    /(?:experience|minimum|at least|min\.?)[^.\n]{0,20}?(\d{1,2})\s*\+?\s*years?/gi,
  ];

  const found = [];
  for (const pattern of patterns) {
    for (const match of description.matchAll(pattern)) {
      const years = parseInt(match[1], 10);
      // Above 15 is almost always a company age or "10,000+ customers" style
      // number that happened to sit near the word "years".
      if (Number.isFinite(years) && years >= 0 && years <= 15) found.push(years);
    }
  }

  return found.length ? Math.min(...found) : null;
}

/** Loose title match: any significant word from any configured keyword. */
function buildTitleWords() {
  const words = new Set();
  for (const keyword of config.search.keywords || []) {
    for (const word of keyword.toLowerCase().split(/\s+/)) {
      if (word.length > 2) words.add(word);
    }
  }
  return [...words];
}

function countSkillMatches(description, skills) {
  if (!description) return 0;
  const lower = description.toLowerCase();
  // Deduplicated: "Go" and "Golang" both being present is one skill, not two.
  const matched = new Set();
  for (const skill of skills) {
    const normalized = skill.toLowerCase();
    if (!lower.includes(normalized)) continue;
    matched.add(normalized.replace(/^golang$/, 'go').replace(/^springboot$/, 'spring boot'));
  }
  return matched.size;
}

function isIndiaEligible(location) {
  if (!location) return true; // unstated: let the AI judge it
  const value = String(location).toLowerCase();

  if (INDIA_LOCATION.test(value)) return true;

  // Remote is only useful if it isn't pinned to another region.
  if (/remote|anywhere|distributed/.test(value)) {
    return !NON_INDIA_LOCATION.test(value);
  }

  return false;
}

function postingAgeDays(postedAt) {
  if (!postedAt) return null;
  const posted = new Date(postedAt);
  if (Number.isNaN(posted.getTime())) return null;
  return (Date.now() - posted.getTime()) / 86400000;
}

/**
 * Returns { pass: true } or { pass: false, reason } for a single job.
 * Checks run cheapest-first.
 */
function evaluate(job, options = {}) {
  const titleWords = options.titleWords || buildTitleWords();
  const title = String(job.title || '').toLowerCase();
  const description = job.description || '';

  if (config.isBlocked(job.company)) {
    return { pass: false, reason: 'company on blocklist' };
  }

  const excluded = (config.search.excludeKeywords || [])
    .map((term) => term.toLowerCase())
    .find((term) => title.includes(term));
  if (excluded) {
    return { pass: false, reason: `title excluded by "${excluded.trim()}"` };
  }

  if (!titleWords.some((word) => title.includes(word))) {
    return { pass: false, reason: 'title matches no search keyword' };
  }

  if (!isIndiaEligible(job.location)) {
    return { pass: false, reason: `location not India-eligible: ${job.location}` };
  }

  const maxAge = config.filter.maxPostingAgeDays;
  const age = postingAgeDays(job.posted_at);
  if (maxAge && age !== null && age > maxAge) {
    return { pass: false, reason: `posted ${Math.round(age)} days ago (max ${maxAge})` };
  }

  const minMatches = config.filter.minRequiredSkillMatches ?? 2;
  const skillMatches = countSkillMatches(description, config.search.requiredSkills || []);
  if (skillMatches < minMatches) {
    return { pass: false, reason: `only ${skillMatches} required skills found (need ${minMatches})` };
  }

  const requiredYears = extractMinYears(description);
  const maxYears = config.search.experienceRange?.max;
  if (requiredYears !== null && maxYears !== undefined && requiredYears > maxYears) {
    return { pass: false, reason: `needs ${requiredYears}+ years (max ${maxYears})` };
  }

  return {
    pass: true,
    signals: {
      skillMatches,
      requiredYears,
      niceToHaveMatches: countSkillMatches(description, config.search.niceToHaveSkills || []),
    },
  };
}

/** Applies evaluate() across a list, returning both sides plus a funnel tally. */
function apply(jobs) {
  const titleWords = buildTitleWords();
  const passed = [];
  const rejected = [];
  const reasonCounts = {};

  for (const job of jobs) {
    const result = evaluate(job, { titleWords });
    if (result.pass) {
      passed.push({ ...job, signals: result.signals });
    } else {
      rejected.push({ ...job, reason: result.reason });
      // Bucket by reason type, not the full string, so counts stay readable.
      const bucket = result.reason.replace(/".*"/, '"…"').replace(/: .*/, '').replace(/\d+/g, 'N');
      reasonCounts[bucket] = (reasonCounts[bucket] || 0) + 1;
    }
  }

  return { passed, rejected, reasonCounts };
}

module.exports = {
  evaluate,
  apply,
  extractMinYears,
  isIndiaEligible,
  countSkillMatches,
  buildTitleWords,
};
