'use strict';

const { postJson, sleep } = require('./http');
const { canonicalKey, htmlToText, toIsoDate } = require('./normalize');
const logger = require('../logger');

const PLATFORM = 'ashby';
const ENDPOINT = 'https://jobs.ashbyhq.com/api/non-user-graphql';

/**
 * Ashby has no REST board API — it uses a GraphQL endpoint, and introspection
 * is disabled, so these queries were derived by probing field names live.
 *
 * Two calls are needed: the board query returns only brief fields (no
 * description, no date, no URL), and details come per posting. That makes
 * Ashby the only collector with N+1 requests, so callers pass a title
 * pre-filter to avoid fetching details for every posting on a large board.
 */
const BOARD_QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    jobPostings { id title locationName employmentType secondaryLocations { locationName } }
  }
}`;

// descriptionHtml is the working field name; descriptionPlain/description
// are rejected by the schema.
const DETAIL_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title descriptionHtml publishedDate employmentType locationName
  }
}`;

const DETAIL_DELAY_MS = 250;

async function fetchBoard(slug) {
  return postJson(`${ENDPOINT}?op=ApiJobBoardWithTeams`, {
    operationName: 'ApiJobBoardWithTeams',
    variables: { organizationHostedJobsPageName: slug },
    query: BOARD_QUERY,
  });
}

async function fetchDetail(slug, postingId) {
  return postJson(`${ENDPOINT}?op=ApiJobPosting`, {
    operationName: 'ApiJobPosting',
    variables: { organizationHostedJobsPageName: slug, jobPostingId: postingId },
    query: DETAIL_QUERY,
  });
}

/**
 * GraphQL returns 200 with an errors array rather than an HTTP error status,
 * so a successful response still has to be checked for errors.
 */
function graphqlError(response) {
  if (!response.ok) return response.error || `HTTP ${response.status}`;
  const errors = response.json?.errors;
  if (Array.isArray(errors) && errors.length) return errors[0].message;
  return null;
}

async function search(slugs, options = {}) {
  const { titleFilter = null, maxDetailsPerBoard = 60 } = options;

  const jobs = [];
  const deadSlugs = [];
  const errors = [];

  for (const slug of slugs) {
    const boardResponse = await fetchBoard(slug);
    const boardError = graphqlError(boardResponse);

    if (boardError) {
      logger.error(`Ashby board query failed: ${slug}`, { error: boardError });
      errors.push({ slug, error: boardError });
      continue;
    }

    const postings = boardResponse.json?.data?.jobBoard?.jobPostings;

    // A valid slug with a null board means the org page does not exist.
    if (!Array.isArray(postings)) {
      logger.warn(`Ashby board not found: ${slug}`);
      deadSlugs.push(slug);
      continue;
    }

    const candidates = (titleFilter ? postings.filter((p) => titleFilter(p.title)) : postings)
      .slice(0, maxDetailsPerBoard);

    logger.debug(`Ashby ${slug}: ${postings.length} postings, fetching ${candidates.length} details`);

    for (const posting of candidates) {
      const detailResponse = await fetchDetail(slug, posting.id);
      const detailError = graphqlError(detailResponse);

      // One bad posting should not abandon the rest of the board.
      if (detailError) {
        logger.debug(`Ashby detail failed: ${slug}/${posting.id}`, { error: detailError });
        continue;
      }

      const detail = detailResponse.json?.data?.jobPosting || {};
      const title = detail.title || posting.title;
      const location = detail.locationName
        || posting.locationName
        || posting.secondaryLocations?.[0]?.locationName
        || null;

      if (!title) continue;

      jobs.push({
        canonical_key: canonicalKey(slug, title, location),
        platform: PLATFORM,
        company: slug,
        title,
        location,
        url: `https://jobs.ashbyhq.com/${slug}/${posting.id}`,
        description: htmlToText(detail.descriptionHtml),
        salary_text: null,
        posted_at: toIsoDate(detail.publishedDate),
      });

      await sleep(DETAIL_DELAY_MS);
    }
  }

  return { platform: PLATFORM, jobs, deadSlugs, errors };
}

module.exports = { search, PLATFORM };
