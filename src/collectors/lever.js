'use strict';

const { getJson } = require('./http');
const { canonicalKey, htmlToText, toIsoDate } = require('./normalize');
const logger = require('../logger');

const PLATFORM = 'lever';

/**
 * Lever's public postings API returns a flat array with plaintext descriptions
 * already included, so one request per board suffices.
 *
 * Shape (verified live):
 *   [ { id, text, hostedUrl, applyUrl, createdAt (epoch ms), workplaceType,
 *       descriptionPlain, description, additionalPlain,
 *       categories: { location, allLocations[], department, commitment } } ]
 */
const boardUrl = (slug) =>
  `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;

function mapJob(raw, slug) {
  const title = raw.text;
  const url = raw.hostedUrl || raw.applyUrl;
  if (!title || !url) return null;

  // Lever has no company field — the board slug is the only source.
  const company = slug;

  const location = raw.categories?.location
    || (raw.categories?.allLocations || [])[0]
    || (raw.workplaceType === 'remote' ? 'Remote' : null);

  // descriptionPlain is the intro only; descriptionBodyPlain and
  // additionalPlain hold requirements. Concatenated so Phase 3 keyword
  // matching sees the full posting.
  const description = [raw.descriptionPlain, raw.descriptionBodyPlain, raw.additionalPlain]
    .filter(Boolean)
    .join('\n\n')
    || htmlToText(raw.description);

  return {
    canonical_key: canonicalKey(company, title, location),
    platform: PLATFORM,
    company,
    title,
    location,
    url,
    description: description || null,
    salary_text: raw.salaryRange
      ? `${raw.salaryRange.currency || ''} ${raw.salaryRange.min || ''}-${raw.salaryRange.max || ''}`.trim()
      : null,
    posted_at: toIsoDate(raw.createdAt),
  };
}

async function search(slugs) {
  const jobs = [];
  const deadSlugs = [];
  const errors = [];

  for (const slug of slugs) {
    const response = await getJson(boardUrl(slug));

    if (response.notFound) {
      logger.warn(`Lever board not found: ${slug}`);
      deadSlugs.push(slug);
      continue;
    }

    if (!response.ok) {
      logger.error(`Lever fetch failed: ${slug}`, { error: response.error });
      errors.push({ slug, error: response.error });
      continue;
    }

    if (!Array.isArray(response.json)) {
      errors.push({ slug, error: 'unexpected response shape: expected an array' });
      continue;
    }

    const mapped = response.json.map((raw) => mapJob(raw, slug)).filter(Boolean);
    jobs.push(...mapped);

    logger.debug(`Lever ${slug}: ${mapped.length} jobs`);
  }

  return { platform: PLATFORM, jobs, deadSlugs, errors };
}

module.exports = { search, PLATFORM };
