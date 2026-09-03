'use strict';

/**
 * Truthfulness gate regression suite. Run: npm run test:tailor
 *
 * This is the most safety-critical test file in the project. A fabricated
 * resume is the one failure mode that damages the user professionally, and it
 * is invisible unless something checks. Every adversarial case below must stay
 * rejected.
 */

const { applyPlan, verify } = require('../src/resume/tailor');
const { loadMaster } = require('../src/resume/render');

const master = loadMaster();
const clone = () => JSON.parse(JSON.stringify(master));

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
  }
}

console.log('Fabrication must be rejected');

const withExtraBullet = clone();
withExtraBullet.experience[0].bullets.push({
  id: 'fabricated',
  text: 'Led a team of 20 engineers at Google.',
  tags: [],
});
check('invented bullet text', verify(master, withExtraBullet).length > 0);

const withExtraSkill = clone();
withExtraSkill.skills.languages.push('Rust');
check('skill outside master vocabulary', verify(master, withExtraSkill).length > 0);

const withInflatedTitle = clone();
withInflatedTitle.experience[0].title = 'Senior Software Engineer';
check('inflated job title', verify(master, withInflatedTitle).length > 0);

const withMovedDates = clone();
withMovedDates.experience[0].startDate = '2022-01';
check('altered start date', verify(master, withMovedDates).length > 0);

const withNewEmployer = clone();
withNewEmployer.experience.push({
  company: 'Google',
  title: 'SWE',
  startDate: '2024-01',
  endDate: null,
  bullets: [],
});
check('invented employer', verify(master, withNewEmployer).length > 0);

const withInventedSummary = clone();
withInventedSummary.summary = {
  default: 'Senior engineer with 8 years of experience leading teams.',
  variants: master.summary.variants,
};
check('invented summary', verify(master, withInventedSummary).length > 0);

const withEditedBullet = clone();
withEditedBullet.experience[0].bullets[0].text =
  withEditedBullet.experience[0].bullets[0].text.replace('35 MB', '350 MB');
check('edited metric inside a real bullet', verify(master, withEditedBullet).length > 0);

console.log('Trim policy');

const allDropped = applyPlan(master, {
  dropBullets: master.experience.flatMap((role) => role.bullets.map((b) => b.id)),
  bulletOrder: [],
});
// The current full-time role is marked trimmable:false and must survive intact.
check('full-time role keeps every bullet', allDropped.experience[0].bullets.length === 4);
check('internships respect their floor',
  allDropped.experience.slice(1).every((role) => role.bullets.length >= (role.minBullets || 1)));
check('mass-drop still verifies clean', verify(master, allDropped).length === 0);

console.log('Legitimate tailoring');

const tailored = applyPlan(master, {
  summaryVariant: 'go',
  bulletOrder: ['flix-rest-apis', 'rbh-dashboard-perf'],
  dropBullets: ['flix-collaboration'],
  skillOrder: ['Go', 'PostgreSQL'],
});
check('reorder plus a legal drop verifies', verify(master, tailored).length === 0);
check('droppable bullet was dropped',
  tailored.experience.find((r) => r.company === 'Flix Logix India').bullets.length === 3);
check('requested summary variant applied', tailored.summary.default === master.summary.variants.go);
check('requested skill promoted', tailored.skills.languages[0] === 'Go');
check('ranked bullet moved to front',
  tailored.experience.find((r) => r.company === 'Flix Logix India').bullets[0].id === 'flix-rest-apis');

console.log('Malformed plans are survivable');

const hallucinated = applyPlan(master, {
  summaryVariant: 'does-not-exist',
  bulletOrder: ['fake-id-1', 'fake-id-2'],
  dropBullets: ['also-fake'],
  skillOrder: ['Haskell'],
});
check('unknown ids ignored', verify(master, hallucinated).length === 0);
check('unknown variant falls back to default', hallucinated.summary.default === master.summary.default);
check('unknown skill does not get added',
  !hallucinated.skills.languages.map((s) => s.toLowerCase()).includes('haskell'));

const emptyPlan = applyPlan(master, {});
check('empty plan produces a valid resume', verify(master, emptyPlan).length === 0);
check('empty plan keeps all bullets',
  emptyPlan.experience.reduce((sum, r) => sum + r.bullets.length, 0)
    === master.experience.reduce((sum, r) => sum + r.bullets.length, 0));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
