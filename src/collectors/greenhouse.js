'use strict';

const { getJson } = require('./http');
const { canonicalKey, htmlToText, toIsoDate } = require('./normalize');
const logger = require('../logger');

const PLATFORM = 'greenhouse';

/**
 * Greenhouse exposes a public JSON board API. content=true returns the full
 * HTML description in the same call, so one request per board is enough.
 *
 * Shape (verified live):
 *   { jobs: [ { id, title, absolute_url, location: { name },
 *               company_name, first_published, updated_at, content } ] }
 */
const boardUrl = (slug) =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;

function mapJob(raw, slug) {
  const company = raw.company_name || slug;
  const title = raw.title;
  const location = raw.location?.name || null;

  if (!title || !raw.absolute_url) return null;

  return {
    canonical_key: canonicalKey(company, title, location),
    platform: PLATFORM,
    company,
    title,
    location,
    url: raw.absolute_url,
    description: htmlToText(raw.content),
    salary_text: null,
    posted_at: toIsoDate(raw.first_published || raw.updated_at),
  };
}

/**
 * Returns { jobs, deadSlugs, errors }. A dead slug is reported rather than
 * thrown: companies migrate between ATS platforms and the slug silently 404s.
 */
async function search(slugs) {
  const jobs = [];
  const deadSlugs = [];
  const errors = [];

  for (const slug of slugs) {
    const response = await getJson(boardUrl(slug));

    if (response.notFound) {
      logger.warn(`Greenhouse board not found: ${slug}`);
      deadSlugs.push(slug);
      continue;
    }

    if (!response.ok) {
      logger.error(`Greenhouse fetch failed: ${slug}`, { error: response.error });
      errors.push({ slug, error: response.error });
      continue;
    }

    const rawJobs = response.json?.jobs;
    if (!Array.isArray(rawJobs)) {
      errors.push({ slug, error: 'unexpected response shape: jobs is not an array' });
      continue;
    }

    const mapped = rawJobs.map((raw) => mapJob(raw, slug)).filter(Boolean);
    jobs.push(...mapped);

    logger.debug(`Greenhouse ${slug}: ${mapped.length} jobs`);
  }

  return { platform: PLATFORM, jobs, deadSlugs, errors };
}

module.exports = { search, PLATFORM };
