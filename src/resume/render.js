'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');
const { render: renderHtml } = require('./template');

/**
 * HTML to PDF via Playwright's page.pdf(). No LaTeX toolchain needed.
 *
 * The browser is launched per call rather than kept warm: resume generation
 * happens a handful of times per run, and a leaked browser process is worse
 * than a second of startup.
 */

const MASTER_PATH = path.join(__dirname, 'master.json');

function loadMaster() {
  const raw = fs.readFileSync(MASTER_PATH, 'utf8');
  const master = JSON.parse(raw);

  if (!master.personal?.name) throw new Error('master.json is missing personal.name');
  if (!Array.isArray(master.experience) || master.experience.length === 0) {
    throw new Error('master.json has no experience entries');
  }

  return master;
}

/**
 * Every technology the resume is allowed to mention. Phase 5's truthfulness
 * rule is enforced against this, not against a prompt instruction.
 */
function allowedVocabulary(master) {
  return Object.values(master.skills)
    .filter(Array.isArray)
    .flat()
    .map((skill) => skill.toLowerCase());
}

async function toPdf(html, outputPath) {
  // Required lazily so Phases 0-4 never pay for the playwright import.
  const { chromium } = require('playwright');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch();
  try {
    // The viewport must match A4 width (8.27in at 96dpi = 794px). At the
    // default 1280px the page lays out too wide, then gets scaled to fit,
    // which pushes a one-page resume onto two.
    const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    // Margins come from the @page rule in the template. Passing them here too
    // applies them twice and pushes a one-page resume onto two.
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }

  return outputPath;
}

/** Slug for filenames: "Acme Corp." -> "AcmeCorp". */
function slug(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Renders a resume PDF. With no tailoring argument this produces the master
 * resume verbatim — the baseline that must match the original LaTeX output.
 */
async function generate(options = {}) {
  const {
    resume = loadMaster(),
    company = null,
    role = null,
    outputDir = path.join(config.root, 'output', 'resumes'),
    label = null,
  } = options;

  const name = slug(resume.personal.name);
  const parts = [name, 'Resume'];
  if (company) parts.push(slug(company));
  if (role) parts.push(slug(role).slice(0, 24));
  if (label) parts.push(label);

  const filename = `${parts.join('_')}.pdf`;
  const outputPath = path.join(outputDir, filename);

  const html = renderHtml(resume);
  await toPdf(html, outputPath);

  const bytes = fs.statSync(outputPath).size;
  logger.info(`Resume written: ${filename}`, { bytes, path: outputPath });

  return { path: outputPath, filename, bytes, html };
}

module.exports = { generate, loadMaster, allowedVocabulary, toPdf, slug, MASTER_PATH };
