'use strict';

const config = require('../config');
const logger = require('../logger');
const { findAnswer, matchOption } = require('./answers');

/**
 * Greenhouse form filling.
 *
 * Observed structure (verified across Groww, GitLab, Cloudflare, Twilio):
 *   - Core fields have stable ids: #first_name, #last_name, #email, #phone,
 *     #country, #candidate-location, #resume, #cover_letter
 *   - Custom questions are #question_<numeric id> — the id is per-posting, so
 *     they must be matched by their visible label, never by id
 *   - Many fields are role="combobox" with a popup list, not <select>; typing
 *     alone does not commit a value
 *   - Every board carries an invisible reCAPTCHA v3, which scores behaviour
 *
 * Nothing here ever clicks submit. That is Phase 7, behind DRY_RUN.
 */

const HUMAN_DELAY_MS = [220, 650];

function randomDelay() {
  const [min, max] = HUMAN_DELAY_MS;
  return min + Math.floor(Math.random() * (max - min));
}

async function pause(page) {
  await page.waitForTimeout(randomDelay());
}

/** Fills a plain text input, if present. Missing optional fields are not errors. */
async function fillText(page, selector, value, { required = false, label = selector } = {}) {
  const field = page.locator(selector).first();
  if ((await field.count()) === 0) {
    if (required) throw new Error(`required field not found: ${label} (${selector})`);
    return { filled: false, reason: 'not present' };
  }
  if (!value) {
    if (required) throw new Error(`no value available for required field: ${label}`);
    return { filled: false, reason: 'no value' };
  }

  await field.fill(String(value));
  await pause(page);
  return { filled: true, value: String(value) };
}

/**
 * Comboboxes need type-then-select: setting the input value leaves the
 * underlying form state empty, so the submission would silently lose it.
 */
async function fillCombobox(page, selector, value, opts = {}) {
  const { label = selector } = opts;
  const field = page.locator(selector).first();
  if ((await field.count()) === 0) return { filled: false, reason: 'not present' };
  if (!value) return { filled: false, reason: 'no value' };

  await field.click();
  await pause(page);

  // Options must be scoped to THIS combobox. The phone-country widget keeps
  // ~244 [role=option] nodes in the DOM at all times, so an unscoped selector
  // silently reads that list instead of the question's own options.
  //
  // aria-controls may be absent until the listbox opens (location autocomplete
  // only creates it after typing), so it is read again after each interaction
  // rather than once up front.
  const listboxId = async () =>
    (await field.getAttribute('aria-controls')) || (await field.getAttribute('aria-owns'));

  const optionsFor = async (id) => page.locator(`#${CSS_escape(id)} [role="option"]`);

  let id = await listboxId();
  let options = id ? await optionsFor(id) : null;
  let count = options ? await options.count() : 0;
  const unfilteredCount = count;

  // Type when the list is long (needs filtering) or absent (autocomplete that
  // only populates on input).
  if (count === 0 || count > 12) {
    await field.fill(String(value));
    await page.waitForTimeout(1200);

    id = await listboxId();
    if (!id) {
      await page.keyboard.press('Escape');
      return { filled: false, reason: 'combobox never opened a listbox' };
    }

    options = await optionsFor(id);
    count = await options.count();

    // Location autocompletes match on the city alone: "Patiala, India" returns
    // nothing while "Patiala" returns 9 results. Retry with the first segment
    // before giving up.
    if (count === 0 && String(value).includes(',')) {
      const firstSegment = String(value).split(',')[0].trim();
      await field.fill('');
      await page.waitForTimeout(400);
      await field.fill(firstSegment);
      await page.waitForTimeout(1500);
      count = await options.count();
    }

    // Typing filtered everything away: restore the full list and match locally.
    if (count === 0 && unfilteredCount > 0) {
      await field.fill('');
      await page.waitForTimeout(800);
      count = await options.count();
    }
  }

  if (count === 0) {
    return { filled: false, reason: `no options in listbox (had ${unfilteredCount} unfiltered)` };
  }

  const texts = [];
  for (let index = 0; index < Math.min(count, 40); index += 1) {
    texts.push((await options.nth(index).textContent())?.trim() || '');
  }

  // For location, prefer an option in the right country when the autocomplete
  // returns same-named cities elsewhere ("Basti Patiala, Punjab, Pakistan").
  let chosen = matchOption(value, texts);
  if (!chosen && opts.preferContaining) {
    chosen = texts.find((text) => text.toLowerCase().includes(opts.preferContaining.toLowerCase()))
      || null;
  }
  if (!chosen) {
    await page.keyboard.press('Escape');
    return { filled: false, reason: `no option matched "${value}"`, options: texts.slice(0, 8) };
  }

  await options.nth(texts.indexOf(chosen)).click();
  await pause(page);
  return { filled: true, value: chosen };
}

const path = require('path');

/**
 * Uploads a file and CONFIRMS it attached.
 *
 * The input's `.files` property cannot be used to verify: Greenhouse replaces
 * the element on upload, so `getElementById(...).files` reads undefined even
 * on success. The reliable signal is the filename appearing in the page text.
 * Verifying on the wrong signal would report false failures here — and, worse,
 * false successes in Phase 7.
 */
async function uploadFile(page, selector, filePath, { label = selector } = {}) {
  const field = page.locator(selector).first();
  if ((await field.count()) === 0) return { filled: false, reason: 'not present' };
  if (!filePath) return { filled: false, reason: 'no file' };

  await field.setInputFiles(filePath);
  await page.waitForTimeout(2500);

  const filename = path.basename(filePath);
  const attached = await page.evaluate(
    (name) => document.body.innerText.includes(name),
    filename
  );

  if (!attached) {
    return { filled: false, reason: 'upload did not confirm — filename not shown on page' };
  }

  return { filled: true, value: filename };
}

/**
 * Reads every custom question on the page with its label, current control
 * type, and options where applicable.
 */
async function readCustomQuestions(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    for (const element of document.querySelectorAll('input:not([type=hidden]),textarea,select')) {
      const id = element.id || '';
      if (!id.startsWith('question_')) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim()
        || element.getAttribute('aria-label')
        || '';

      results.push({
        id,
        label: label.replace(/\s+/g, ' ').replace(/\*$/, '').trim(),
        tag: element.tagName.toLowerCase(),
        type: element.type || '',
        role: element.getAttribute('role') || '',
        required: element.required || label.includes('*'),
      });
    }

    return results;
  });
}

/**
 * Fills a Greenhouse application form.
 *
 * Returns { filled, skipped, unanswered }. A non-empty `unanswered` means the
 * application must be routed to needs_manual — the bot does not guess.
 */
async function fill(page, { resumePath, coverLetterPath = null }) {
  const profile = config.profile;
  const bank = config.answerBank;

  const filled = [];
  const skipped = [];
  const unanswered = [];

  const record = (label, result) => {
    if (result.filled) filled.push({ label, value: result.value });
    else skipped.push({ label, reason: result.reason, options: result.options });
  };

  const [firstName, ...rest] = String(profile.name || '').split(' ');
  const lastName = rest.join(' ');

  record('First Name', await fillText(page, '#first_name', firstName, { required: true, label: 'First Name' }));
  record('Last Name', await fillText(page, '#last_name', lastName, { required: true, label: 'Last Name' }));
  record('Email', await fillText(page, '#email', profile.email, { required: true, label: 'Email' }));
  record('Phone', await fillText(page, '#phone', profile.phone, { label: 'Phone' }));

  // Country and location are comboboxes on every board seen so far.
  record('Country', await fillCombobox(page, '#country', 'India', { label: 'Country' }));
  record('Location', await fillCombobox(page, '#candidate-location', profile.location, {
    label: 'Location',
    preferContaining: 'India',
  }));

  record('Resume', await uploadFile(page, '#resume', resumePath, { label: 'Resume' }));
  if (coverLetterPath) {
    record('Cover Letter', await uploadFile(page, '#cover_letter', coverLetterPath, { label: 'Cover Letter' }));
  }

  const questions = await readCustomQuestions(page);
  logger.debug(`Greenhouse: ${questions.length} custom questions`);

  for (const question of questions) {
    const match = findAnswer(question.label);

    if (!match) {
      // Captured verbatim so it can be added to the answer bank.
      unanswered.push({ id: question.id, label: question.label, required: question.required });
      continue;
    }

    const selector = `#${CSS_escape(question.id)}`;
    const result = question.role === 'combobox'
      ? await fillCombobox(page, selector, match.answer, { label: question.label })
      : await fillText(page, selector, match.answer, { label: question.label });

    if (!result.filled && question.required) {
      unanswered.push({
        id: question.id,
        label: question.label,
        required: true,
        reason: result.reason,
        options: result.options,
      });
    } else {
      record(question.label, result);
    }
  }

  return { filled, skipped, unanswered, questionCount: questions.length };
}

/** CSS.escape is a browser API; ids here are safe but this keeps it explicit. */
function CSS_escape(value) {
  return String(value).replace(/([^\w-])/g, '\\$1');
}

/**
 * Greenhouse uses invisible reCAPTCHA v3, which scores behaviour rather than
 * showing a puzzle. Nothing is solved or bypassed here — this only reports
 * presence so a submission attempt can be routed to needs_manual if the
 * platform challenges it.
 */
async function detectCaptcha(page) {
  const present = await page.locator('textarea[name="g-recaptcha-response"]').count();
  const visible = await page.locator('iframe[src*="recaptcha"][src*="size=normal"]').count();
  return { present: present > 0, interactive: visible > 0 };
}

module.exports = { fill, detectCaptcha, readCustomQuestions, PLATFORM: 'greenhouse' };
