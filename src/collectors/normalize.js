'use strict';

/**
 * Canonical key generation for deduplication.
 *
 * The same role appears on several boards under different URLs, so the URL is
 * not a usable identity. The key is normalized company + title + location.
 *
 * The rule that matters: seniority markers are PRESERVED (Senior vs Staff are
 * different jobs and must not collapse), while formatting noise, remote
 * markers, and req IDs are stripped.
 */

const LEGAL_SUFFIXES = [
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'bv', 'nv', 'sa', 'ag', 'ab', 'oy', 'as',
  'pvt', 'private', 'pte', 'llp', 'technologies', 'technology', 'labs',
  'software', 'solutions', 'systems', 'group', 'holdings', 'international',
];

// Stripped from titles: formatting noise that varies between boards for the
// same role. Seniority words are deliberately absent from this list.
const TITLE_NOISE = [
  'remote', 'hybrid', 'onsite', 'on-site', 'wfh', 'work from home',
  'full time', 'full-time', 'fulltime', 'part time', 'part-time',
  'contract', 'permanent', 'new', 'urgent', 'hiring', 'immediate joiner',
  'f/m/d', 'm/f/d', 'm/w/d', 'h/f', 'all genders', 'any gender',
];

function collapse(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')        // punctuation to space
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompany(company) {
  let value = collapse(company);

  // Strip trailing legal suffixes repeatedly: "Acme Technologies Pvt Ltd".
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const pattern = new RegExp(`\\s${suffix}$`);
      if (pattern.test(value)) {
        value = value.replace(pattern, '');
        changed = true;
      }
    }
  }

  return value.trim();
}

function normalizeTitle(title) {
  let value = collapse(title);

  // Bracketed segments are almost always noise: "(Remote)", "[Bangalore]".
  value = String(title || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ');
  value = collapse(value);

  // Trailing req/job IDs: "Backend Engineer 12345", "SDE II JR-4471".
  value = value.replace(/\b(?:jr|req|job|id|no)?\s*[-#]?\s*\d{3,}\b/g, ' ');

  for (const noise of TITLE_NOISE) {
    value = value.replace(new RegExp(`\\b${noise}\\b`, 'g'), ' ');
  }

  // Roman/numeric level markers are meaningful (SDE II != SDE III) and are
  // normalized to digits so "SDE II" and "SDE 2" collapse together.
  value = value
    .replace(/\biii\b/g, '3')
    .replace(/\bii\b/g, '2')
    .replace(/\biv\b/g, '4')
    .replace(/\bi\b/g, '1');

  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Location is normalized to a coarse bucket. Boards write the same place many
 * ways ("Bengaluru-VTP, India", "Bangalore, KA"), and over-precision here
 * defeats deduplication.
 */
function normalizeLocation(location) {
  const value = collapse(location);
  if (!value) return 'unspecified';

  if (/\b(remote|anywhere|distributed|work from home|wfh)\b/.test(value)) {
    // "Remote, North America" and "Remote, Australia" are different jobs you
    // cannot apply to interchangeably, so the region is kept when present.
    // Only the first region is used: multi-region postings list them in
    // varying order, and keeping all of them would defeat deduplication.
    const REGIONS = [
      'india', 'north america', 'americas', 'latam', 'emea', 'apac', 'europe',
      'australia', 'canada', 'united states', 'usa', 'united kingdom', 'uk',
      'germany', 'ireland', 'netherlands', 'poland', 'spain', 'france',
      'singapore', 'japan', 'brazil', 'mexico',
    ];
    const region = REGIONS.find((name) => new RegExp(`\\b${name}\\b`).test(value));
    return region ? `remote ${region}` : 'remote';
  }

  const CITY_ALIASES = {
    bengaluru: 'bangalore',
    blr: 'bangalore',
    gurugram: 'gurgaon',
    ncr: 'delhi',
    'new delhi': 'delhi',
    bombay: 'mumbai',
    madras: 'chennai',
    calcutta: 'kolkata',
    sfo: 'san francisco',
    nyc: 'new york',
  };

  // Take the first segment ("Bengaluru-VTP, India" -> "bengaluru vtp"), then
  // its first word, which is nearly always the city.
  const firstSegment = value.split(',')[0].trim();
  const firstWord = firstSegment.split(' ')[0];

  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    if (firstSegment.startsWith(alias)) return canonical;
  }

  return firstWord || 'unspecified';
}

function canonicalKey(company, title, location) {
  return [
    normalizeCompany(company),
    normalizeTitle(title),
    normalizeLocation(location),
  ].join('|');
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // &amp; must be decoded last, otherwise "&amp;lt;" turns into "<".
    .replace(/&amp;/g, '&');
}

function stripTags(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Boards return descriptions as HTML. Stored as text so keyword filtering in
 * Phase 3 works on words rather than markup.
 *
 * Greenhouse double-encodes: content arrives as "&lt;div&gt;...", so entities
 * must be decoded BEFORE stripping tags, and the decode/strip pair runs twice
 * to handle the resulting markup.
 */
function htmlToText(html) {
  if (!html) return null;

  let value = decodeEntities(String(html));
  value = stripTags(value);

  // Second pass: only if decoding revealed markup underneath.
  if (/<[a-z][\s\S]*>/i.test(value)) {
    value = stripTags(decodeEntities(value));
  }

  return decodeEntities(value)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Boards use ISO strings, epoch millis, and date-only strings. */
function toIsoDate(value) {
  if (!value) return null;

  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

module.exports = {
  normalizeCompany,
  normalizeTitle,
  normalizeLocation,
  canonicalKey,
  htmlToText,
  toIsoDate,
};
