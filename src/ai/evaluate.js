'use strict';

const config = require('./../config');
const logger = require('./../logger');
const queries = require('./../db/queries');
const { complete, parseJson, sleep } = require('./client');

/**
 * Scores a shortlisted job against the user's profile.
 *
 * The score is decomposed rather than holistic: a bare number cannot be tuned,
 * but "skills 8, seniority 3" tells you which dimension is wrong. Weights are
 * applied here in code, not by the model — models are unreliable arithmetic
 * engines, and doing it locally makes the scoring auditable and stable.
 */

const WEIGHTS = {
  skills: 3,
  experience: 2,
  domain: 2,
  seniority: 2,
  project: 1,
};

// Gemini's structured-output schema. Constrains shape, so parsing rarely fails.
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    skills: { type: 'INTEGER' },
    experience: { type: 'INTEGER' },
    domain: { type: 'INTEGER' },
    seniority: { type: 'INTEGER' },
    project: { type: 'INTEGER' },
    reason: { type: 'STRING' },
    concerns: { type: 'STRING' },
  },
  required: ['skills', 'experience', 'domain', 'seniority', 'project', 'reason'],
};

function buildProfileBlock() {
  const { profile, search } = config;

  return [
    `Name: ${profile.name}`,
    `Based in: ${profile.location} (India)`,
    `Full-time experience: ${profile.yearsOfExperience} year(s)`,
    `Internship experience: ${profile.internshipYears || 0} year(s) — substantive production backend work, not coursework`,
    `Total relevant experience: ${profile.totalExperienceYears || profile.yearsOfExperience} year(s)`,
    `Education: ${profile.education?.degree} from ${profile.education?.institution}, ${profile.education?.graduationYear}`,
    '',
    `Core skills: ${(search.requiredSkills || []).join(', ')}`,
    `Secondary skills: ${(search.niceToHaveSkills || []).join(', ')}`,
    '',
    'Background summary:',
    '- Backend engineer: Java/Spring Boot, Go/Echo, Node.js. Builds REST and gRPC APIs.',
    '- Production work: WebSocket streaming for 35MB payloads; cut dashboard load 8-10s to <1s',
    '  via backend pagination + Valkey caching (~70% hit rate); cut CouchDB batch processing',
    '  from 15-17min to <20s by replacing N+1 updates with batch operations.',
    '- Built 30+ REST APIs in Go (Echo) with Redis and ArangoDB for a multi-role cab platform.',
    '- Built a real-time messaging backend for 100+ concurrent users (Express, TypeScript, Socket.io);',
    '  improved MongoDB query performance 32% via schema refactoring and compound indexing.',
    '- Databases: PostgreSQL, MongoDB, Redis, CouchDB, ArangoDB. Docker, AWS (EC2/S3), CI/CD.',
    '- 200+ LeetCode problems solved.',
  ].join('\n');
}

function buildPrompt(job) {
  // Descriptions run to several thousand words; the first 4000 chars reliably
  // covers the role summary and requirements, which is what scoring needs.
  const description = String(job.description || '').slice(0, 4000);

  return `You are screening a job posting for a specific candidate. Be strict and realistic — this candidate is early-career, and a bad application wastes a one-shot opportunity with that company.

CANDIDATE
${buildProfileBlock()}

JOB POSTING
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'not stated'}

${description}

TASK
Rate each dimension 0-10, where 0 is no fit and 10 is an excellent fit:

- skills: overlap between the candidate's stack and what this role actually requires.
    Reward transferable backend depth (Java/Go/Node are interchangeable for most
    backend work); penalise a genuinely different stack (e.g. Ruby-only, .NET-only,
    frontend-heavy, or a specialisation like ML the candidate does not have).
- experience: does the candidate's experience meet what this role needs? Count the
    ~2 years total (1 full-time + 1 internship), weighting full-time higher. A role
    asking 2-4 years is a reasonable stretch for this candidate, not a disqualifier —
    score 6-7, not 3. Reserve 0-3 for roles genuinely out of reach (6+ years).
- domain: relevance of the candidate's background (fintech/SCADA/logistics/messaging)
    to this company's problem space. Neutral (5) when the domain is generic.
- seniority: is this the right LEVEL for an early-career engineer? Judge the level
    the role targets, not whether the candidate is the strongest possible applicant.
      9-10 = new grad, SDE-1, junior, associate, entry-level
      7-8  = intermediate / SDE-2 / "2-4 years" — a realistic stretch, score here
      4-6  = mid-level asking 4-5 years
      0-3  = senior, staff, principal, lead, manager, or 6+ years required
    Do not double-penalise here for the years gap; that is what the experience
    dimension measures.
- project: has the candidate built something concretely similar to this role's work?

Then:
- reason: ONE sentence, max 20 words, plain and specific. Name the actual match or
    the actual gap. No filler, no restating the job title.
- concerns: the single biggest risk in applying, or "" if none.

Be honest about gaps. Do not inflate scores to be encouraging.`;
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(10, Math.round(number)));
}

/** Weighted mean of the five dimensions, on a 0-10 scale. */
function computeScore(dimensions) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    weightedSum += clampScore(dimensions[key]) * weight;
    totalWeight += weight;
  }

  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

async function evaluateJob(job) {
  const response = await complete(buildPrompt(job), {
    model: config.ai.cheapModel,
    maxTokens: 900,
    schema: config.ai.provider === 'openai' ? null : RESPONSE_SCHEMA,
  });

  const parsed = parseJson(response.text);
  if (!parsed) {
    throw new Error(`unparseable AI response: ${String(response.text).slice(0, 120)}`);
  }

  const dimensions = {
    skills: clampScore(parsed.skills),
    experience: clampScore(parsed.experience),
    domain: clampScore(parsed.domain),
    seniority: clampScore(parsed.seniority),
    project: clampScore(parsed.project),
  };

  const reason = String(parsed.reason || '').trim() || 'no reason given';
  const concerns = String(parsed.concerns || '').trim();

  return {
    score: computeScore(dimensions),
    dimensions,
    reason: concerns ? `${reason} [risk: ${concerns}]` : reason,
    model: config.ai.cheapModel,
    tokensUsed: response.inputTokens + response.outputTokens,
    costUsd: response.costUsd,
  };
}

/**
 * Scores a list of jobs, pacing calls to stay inside free-tier rate limits.
 *
 * A failure on one job never aborts the batch: the job keeps its current
 * status and is retried on the next run. Never submit on an unscored job.
 */
async function evaluateJobs(jobs, options = {}) {
  const { onProgress = null } = options;
  const results = [];
  let failures = 0;

  const spentThisMonth = queries.getMonthlySpend();
  const budget = config.ai.monthlyBudgetUsd;

  for (const [index, job] of jobs.entries()) {
    if (budget && queries.getMonthlySpend() >= budget) {
      logger.error(`Monthly AI budget of $${budget} reached — stopping.`, {
        spent: queries.getMonthlySpend(),
        remaining: jobs.length - index,
      });
      break;
    }

    try {
      const evaluation = await evaluateJob(job);

      queries.insertEvaluation({
        job_id: job.id,
        score: evaluation.score,
        reason: evaluation.reason,
        model: evaluation.model,
        tokens_used: evaluation.tokensUsed,
        cost_usd: evaluation.costUsd,
      });

      const threshold = config.filter.minScoreToPrepare;
      queries.setJobStatus(job.id, evaluation.score >= threshold ? 'shortlisted' : 'filtered_out',
        evaluation.score >= threshold ? null : `AI score ${evaluation.score} below ${threshold}`);

      results.push({ job, ...evaluation });
      if (onProgress) onProgress(job, evaluation, index + 1, jobs.length);
    } catch (err) {
      failures += 1;
      // Left at its current status so the next run picks it up again.
      logger.error(`Evaluation failed for job ${job.id}`, { title: job.title, error: err.message });
    }

    if (index < jobs.length - 1) await sleep(config.ai.requestDelayMs);
  }

  return { results, failures, spentBefore: spentThisMonth };
}

module.exports = { evaluateJob, evaluateJobs, computeScore, buildPrompt, WEIGHTS };
