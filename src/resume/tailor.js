'use strict';

const config = require('../config');
const logger = require('../logger');
const { complete, parseJson } = require('../ai/client');
const { loadMaster, allowedVocabulary } = require('./render');

/**
 * Tailors the master resume to a specific job.
 *
 * The hard rule from the PRD: tailoring may ONLY reorder, subset, or select
 * among pre-written content. It may never add a skill, employer, date, metric
 * or claim.
 *
 * That is enforced structurally rather than by prompt: the model returns
 * bullet IDs and a summary variant KEY, never prose. Text is then looked up
 * from master.json. A model that hallucinates an ID gets it dropped; it has no
 * channel through which invented text could reach the PDF.
 */

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summaryVariant: { type: 'STRING' },
    bulletOrder: { type: 'ARRAY', items: { type: 'STRING' } },
    dropBullets: { type: 'ARRAY', items: { type: 'STRING' } },
    skillOrder: { type: 'ARRAY', items: { type: 'STRING' } },
    rationale: { type: 'STRING' },
  },
  required: ['summaryVariant', 'bulletOrder', 'rationale'],
};

function collectBullets(master) {
  const entries = [];

  for (const role of master.experience) {
    for (const bullet of role.bullets) {
      entries.push({
        id: bullet.id,
        text: bullet.text,
        tags: bullet.tags || [],
        source: role.company,
        trimmable: Boolean(role.trimmable),
      });
    }
  }
  for (const project of master.projects || []) {
    for (const bullet of project.bullets) {
      entries.push({
        id: bullet.id,
        text: bullet.text,
        tags: bullet.tags || [],
        source: project.name,
        trimmable: Boolean(project.trimmable),
      });
    }
  }

  return entries;
}

function buildPrompt(master, job) {
  const bullets = collectBullets(master);
  const variants = Object.keys(master.summary.variants || {});

  const bulletList = bullets
    .map((b) => `  ${b.id} [${b.source}${b.trimmable ? ', droppable' : ', required'}] tags: ${b.tags.join(', ')}\n     "${b.text.slice(0, 180)}"`)
    .join('\n');

  const description = String(job.description || '').slice(0, 3000);

  return `You are selecting which pre-written resume bullets best fit a job. You are NOT writing anything.

JOB
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'not stated'}

${description}

AVAILABLE BULLETS (these are the ONLY bullets that exist)
${bulletList}

SUMMARY VARIANTS: ${variants.join(', ')}

TASK
1. summaryVariant: pick the ONE variant key that best matches this job.
2. bulletOrder: for each source (company/project), list its bullet IDs most-relevant first.
   Include every ID you are keeping. Order matters — the most relevant bullet
   for THIS job should come first within its role.
3. dropBullets: IDs to omit. You may ONLY drop bullets marked "droppable".
   Drop only when a bullet is genuinely irrelevant to this job. Dropping
   nothing is a valid answer.
4. skillOrder: technology names from the job description that the candidate
   already has, most important first. Used to reorder existing skill lines.
5. rationale: one sentence, max 20 words, on what you prioritised and why.

RULES
- Use ONLY the IDs listed above. Do not invent IDs.
- Do not write or rewrite any bullet text. You are ordering, not authoring.
- Do not suggest skills the candidate does not already have.`;
}

/**
 * Applies a selection plan to the master resume. Anything the model returned
 * that is not a known ID is ignored, and every guard here is a backstop
 * against a bad plan rather than an expected path.
 */
function applyPlan(master, plan) {
  const resume = JSON.parse(JSON.stringify(master));
  const dropped = new Set(Array.isArray(plan.dropBullets) ? plan.dropBullets : []);
  const order = Array.isArray(plan.bulletOrder) ? plan.bulletOrder : [];
  const rank = new Map(order.map((id, index) => [id, index]));

  const reorderSection = (section) => {
    const original = section.bullets;
    const minBullets = section.minBullets ?? original.length;

    let kept = original.filter((bullet) => {
      if (!dropped.has(bullet.id)) return true;
      // A non-trimmable section never loses bullets, whatever the plan says.
      return !section.trimmable;
    });

    // Never fall below the floor: restore highest-priority dropped bullets.
    if (kept.length < minBullets) {
      const restorable = original
        .filter((bullet) => !kept.includes(bullet))
        .sort((a, b) => (a.priority || 9) - (b.priority || 9));
      while (kept.length < minBullets && restorable.length) {
        kept.push(restorable.shift());
      }
    }

    kept.sort((a, b) => {
      const aRank = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const bRank = rank.has(b.id) ? rank.get(b.id) : Infinity;
      if (aRank !== bRank) return aRank - bRank;
      // Unranked bullets fall back to their authored priority.
      return (a.priority || 9) - (b.priority || 9);
    });

    section.bullets = kept;
  };

  for (const role of resume.experience) reorderSection(role);
  for (const project of resume.projects || []) reorderSection(project);

  const variant = resume.summary.variants?.[plan.summaryVariant];
  resume.summary = { default: variant || resume.summary.default, variants: resume.summary.variants };

  // Skill reordering: promote matching skills within their existing line.
  // Nothing is added, only moved.
  const wanted = (Array.isArray(plan.skillOrder) ? plan.skillOrder : [])
    .map((skill) => String(skill).toLowerCase());
  if (wanted.length) {
    for (const [key, list] of Object.entries(resume.skills)) {
      if (!Array.isArray(list)) continue;
      resume.skills[key] = [...list].sort((a, b) => {
        const aIndex = wanted.indexOf(a.toLowerCase());
        const bIndex = wanted.indexOf(b.toLowerCase());
        return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex);
      });
    }
  }

  return resume;
}

/**
 * The truthfulness gate. Compares a tailored resume against the master and
 * fails on ANY text that is not present verbatim in the source.
 *
 * This is what makes the no-fabrication rule real: even if the model found a
 * way to inject prose, it cannot pass this check.
 */
function verify(master, tailored) {
  const problems = [];

  const masterText = new Set();
  for (const role of master.experience) {
    for (const bullet of role.bullets) masterText.add(bullet.text);
  }
  for (const project of master.projects || []) {
    for (const bullet of project.bullets) masterText.add(bullet.text);
  }

  for (const role of tailored.experience) {
    for (const bullet of role.bullets) {
      if (!masterText.has(bullet.text)) {
        problems.push(`bullet text not in master: "${bullet.text.slice(0, 60)}…"`);
      }
    }
    const source = master.experience.find((r) => r.company === role.company);
    if (!source) {
      problems.push(`employer not in master: ${role.company}`);
      continue;
    }
    if (role.title !== source.title) problems.push(`title changed for ${role.company}`);
    if (role.startDate !== source.startDate || role.endDate !== source.endDate) {
      problems.push(`dates changed for ${role.company}`);
    }
    const floor = source.minBullets ?? source.bullets.length;
    if (role.bullets.length < floor) {
      problems.push(`${role.company} kept ${role.bullets.length} bullets, floor is ${floor}`);
    }
  }

  const allowed = new Set(allowedVocabulary(master));
  for (const list of Object.values(tailored.skills)) {
    if (!Array.isArray(list)) continue;
    for (const skill of list) {
      if (!allowed.has(skill.toLowerCase())) {
        problems.push(`skill not in master vocabulary: ${skill}`);
      }
    }
  }

  const summaryText = typeof tailored.summary === 'string' ? tailored.summary : tailored.summary.default;
  const allowedSummaries = [
    master.summary.default,
    ...Object.values(master.summary.variants || {}),
  ];
  if (!allowedSummaries.includes(summaryText)) {
    problems.push('summary is not one of the pre-written variants');
  }

  return problems;
}

async function tailorFor(job, options = {}) {
  const master = options.master || loadMaster();

  let plan;
  try {
    const response = await complete(buildPrompt(master, job), {
      model: config.ai.cheapModel,
      maxTokens: 1200,
      schema: config.ai.provider === 'openai' ? null : RESPONSE_SCHEMA,
    });
    plan = parseJson(response.text);
  } catch (err) {
    logger.warn('Tailoring call failed, using master resume unchanged', { error: err.message });
    return { resume: master, tailored: false, reason: err.message };
  }

  if (!plan) {
    logger.warn('Tailoring returned unparseable output, using master resume unchanged');
    return { resume: master, tailored: false, reason: 'unparseable plan' };
  }

  const tailored = applyPlan(master, plan);
  const problems = verify(master, tailored);

  // Falling back to the master is always safe: it is true by construction.
  if (problems.length) {
    logger.error('Tailored resume failed verification, falling back to master', { problems });
    return { resume: master, tailored: false, reason: problems.join('; '), problems };
  }

  return { resume: tailored, tailored: true, plan, rationale: plan.rationale };
}

module.exports = { tailorFor, applyPlan, verify, buildPrompt, collectBullets };
