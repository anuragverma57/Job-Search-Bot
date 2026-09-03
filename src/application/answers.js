'use strict';

const config = require('../config');

/**
 * Maps a form question to an answer from the config answer bank.
 *
 * The rule from the PRD: the bot never guesses. A question with no confident
 * match routes the whole application to needs_manual with the question text
 * captured verbatim, so it can be added to the bank and answered next time.
 */

/**
 * Patterns are ordered most-specific first. Each entry lists phrases that must
 * ALL appear (an array) or any single phrase (a string).
 */
const QUESTION_PATTERNS = [
  { key: 'requiresSponsorship', match: [['sponsorship'], ['visa', 'require'], ['require', 'immigration']] },
  { key: 'workAuthorization', match: [['authorized', 'work'], ['legally', 'work'], ['work authorization'], ['right to work']] },
  { key: 'noticePeriod', match: [['notice period'], ['notice', 'current employment'], ['how soon', 'join'], ['when can you start']] },
  { key: 'expectedCompensation', match: [['expected', 'compensation'], ['expected', 'salary'], ['expected ctc'], ['salary expectation'], ['desired salary']] },
  { key: 'currentCompensation', match: [['current', 'compensation'], ['current', 'salary'], ['current ctc']] },
  { key: 'willingToRelocate', match: [['relocate'], ['willing', 'move']] },
  { key: 'preferredStartDate', match: [['start date'], ['available', 'start']] },
  { key: 'howDidYouHear', match: [['how did you hear'], ['how did you find'], ['referral source'], ['where did you hear']] },
  { key: 'yearsOfExperience', match: [['years', 'experience'], ['total experience'], ['years of relevant']] },
  { key: 'highestDegree', match: [['degree'], ['highest', 'education'], ['qualification']] },
  { key: 'graduationYear', match: [['graduation year'], ['year', 'graduat']] },
  { key: 'linkedin', match: [['linkedin']] },
  { key: 'github', match: [['github'], ['git hub']] },
  { key: 'portfolio', match: [['portfolio'], ['personal website'], ['website']] },
  { key: 'eeoGender', match: [['gender']] },
  { key: 'eeoRace', match: [['race'], ['ethnicity']] },
  { key: 'eeoVeteran', match: [['veteran'], ['military']] },
  { key: 'eeoDisability', match: [['disability']] },
  // Observed on real Greenhouse forms (GitLab, Groww):
  { key: 'preferredName', match: [['name', 'prefer'], ['preferred name']] },
  { key: 'countryOfResidence', match: [['country of residence'], ['current country']] },
  { key: 'locatedUsCanada', match: [['located', 'us or canada'], ['located', 'united states or canada']] },
  { key: 'employmentAgreements', match: [['employment agreement'], ['post-employment restriction'], ['non-compete']] },
  { key: 'previouslyEmployed', match: [['previously worked'], ['previously been employed'], ['worked at or consulted']] },
  { key: 'accommodations', match: [['adjustments'], ['accommodation'], ['accessible', 'interview']] },
  { key: 'primaryLanguage', match: [['primary programming language'], ['primary language', 'framework']] },
  { key: 'openSourceLinks', match: [['open source'], ['contributions to']] },
  { key: 'relativeAtCompany', match: [['relative', 'working'], ['family member', 'working']] },
  { key: 'backgroundCheckConsent', match: [['background', 'consent'], ['consent', 'background verification']] },
];

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Values that live outside answerBank — profile links and derived facts.
 */
function resolveValue(key) {
  const bank = config.answerBank || {};
  if (bank[key] !== undefined && bank[key] !== '') return bank[key];

  const profile = config.profile || {};
  const links = { linkedin: profile.linkedin, github: profile.github, portfolio: profile.portfolio };
  if (links[key]) return links[key];

  return null;
}

/**
 * Returns { key, answer } for a question, or null when nothing matches
 * confidently. Null is the signal to route to needs_manual.
 */
function findAnswer(questionText) {
  const question = normalize(questionText);
  if (!question) return null;

  for (const { key, match } of QUESTION_PATTERNS) {
    for (const phrases of match) {
      const terms = Array.isArray(phrases) ? phrases : [phrases];
      if (terms.every((term) => question.includes(term))) {
        const answer = resolveValue(key);
        // A matched pattern with an empty config value is still unanswered —
        // guessing would be worse than routing to manual.
        return answer ? { key, answer: String(answer) } : null;
      }
    }
  }

  return null;
}

/**
 * Picks the best option from a dropdown for a known answer.
 *
 * Yes/no questions dominate these forms, so those are handled explicitly;
 * otherwise it falls back to exact, then substring matching. Returns null
 * rather than a poor guess.
 */
function matchOption(answer, options) {
  const target = normalize(answer);
  const normalized = options.map((option) => ({ raw: option, norm: normalize(option) }));

  const exact = normalized.find((option) => option.norm === target);
  if (exact) return exact.raw;

  const affirmative = /^(yes|y|true)$/.test(target);
  const negative = /^(no|n|false|none)$/.test(target);

  if (affirmative || negative) {
    const wanted = affirmative ? /^yes\b/ : /^no\b/;
    const hit = normalized.find((option) => wanted.test(option.norm));
    if (hit) return hit.raw;
  }

  // "Prefer not to say" appears with many phrasings.
  if (/prefer not/.test(target)) {
    const hit = normalized.find((option) => /prefer not|decline|don't wish|do not wish/.test(option.norm));
    if (hit) return hit.raw;
  }

  // Word-boundary match before loose substring: "India" must not select
  // "British Indian Ocean Territory". This actually happened.
  const wordBoundary = new RegExp(`(^|[^a-z])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
  const boundaryHit = normalized.find((option) => wordBoundary.test(option.norm));
  if (boundaryHit) return boundaryHit.raw;

  // Loose substring is a last resort, and only when the option is not
  // substantially longer than the answer — a long option containing a short
  // answer is usually a different thing entirely.
  const contains = normalized.find((option) => {
    if (option.norm.length < 2) return false;
    if (option.norm.includes(target)) return option.norm.length <= target.length * 2;
    return target.includes(option.norm) && option.norm.length >= target.length / 2;
  });
  if (contains) return contains.raw;

  return null;
}

module.exports = { findAnswer, matchOption, normalize, QUESTION_PATTERNS };
