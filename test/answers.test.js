'use strict';

/**
 * Answer bank regression suite. Run: npm run test:answers
 *
 * Two failure modes matter here, and both were observed on real forms:
 *   - matching a question and filling the WRONG option (the "India" ->
 *     "British Indian Ocean Territory" bug)
 *   - failing to match a question that the bank can genuinely answer, which
 *     sends an otherwise-complete application to needs_manual
 *
 * A question the bank cannot answer MUST return null. Guessing puts false
 * statements on a real application.
 */

const { findAnswer, matchOption } = require('../src/application/answers');

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

function answers(question, expected) {
  const result = findAnswer(question);
  const actual = result ? result.answer : null;
  check(`${expected === null ? 'manual' : expected} <- ${question.slice(0, 48)}`, actual === expected);
}

console.log('Questions seen on real Greenhouse forms');
answers('Will you now or in the future require sponsorship for a visa to remain in your current location?', 'No');
answers('What is your current country of residence?', 'India');
answers('Are you located in the US or Canada?', 'No');
answers('Have you previously worked at or consulted for GitLab?', 'No');
answers('What is your primary programming language and/or framework?', 'Java, Go');
answers('Are you subject to any employment agreements and/or post-employment restrictions with your current employer?', 'No');
answers("What's the name you'd prefer us to use throughout the interview process?", 'Anurag');
answers('What is the notice period in your current employment?', '30 days');
answers('Do you have a relative/ family member working currently in Groww?', 'No');
// Read from config rather than hardcoded, so editing the profile does not
// break the test.
answers('LinkedIn Profile Link', require('../src/config').profile.linkedin);

console.log('Open questions must route to manual');
// A blank config value is deliberate: these need a human, and a guess would
// put words in the candidate's mouth.
answers('Please share links of any open source projects you own or have made contributions to', null);
answers('Please let us know if there are any adjustments we can make to assist you', null);
answers('What makes you ideal for this role?', null);
answers('Describe a time you disagreed with a teammate', null);
answers('Why do you want to work here?', null);
answers('', null);

console.log('Option matching');
const countries = ['Afghanistan', 'British Indian Ocean Territory', 'India', 'Indonesia', 'United States'];
// This exact bug reached a real form: "India" selected "British Indian Ocean
// Territory" because a loose substring match ran before a word-boundary one.
check('India does not match British Indian Ocean Territory',
  matchOption('India', countries) === 'India');
check('exact match wins over prefix', matchOption('India', ['India', 'Indian Ocean']) === 'India');
check('no matches yes', matchOption('No', ['Yes', 'No', 'Prefer not to say']) === 'No');
check('yes matches a longer yes option',
  matchOption('Yes', ['No', 'Yes, I am authorized']) === 'Yes, I am authorized');
check('prefer not to say variants',
  matchOption('Prefer not to say', ['Male', 'Female', 'I prefer not to say']) === 'I prefer not to say');
check('no plausible option returns null', matchOption('Rust', ['Java', 'Go', 'Python']) === null);
check('empty option list returns null', matchOption('Yes', []) === null);
check('30 days matches a notice-period option',
  matchOption('30 days', ['Immediate', '15 days', '30 days', '60 days']) === '30 days');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
