'use strict';

/**
 * Deterministic filter regression suite. Run: npm run test:filter
 *
 * The filter decides what the AI ever sees, so a bug here silently hides jobs
 * or wastes quota. These cases encode decisions that were wrong at least once.
 */

const filter = require('../src/filter');

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

const BASE = {
  company: 'TestCo',
  title: 'Backend Engineer',
  location: 'Bengaluru, India',
  description: 'Java Spring Boot PostgreSQL REST microservices',
  posted_at: new Date().toISOString(),
};

const evaluate = (overrides) => filter.evaluate({ ...BASE, ...overrides });

console.log('Seniority exclusions');
// "senior" was missing from the exclude list on the first pass and 13 senior
// roles reached the AI.
check('senior rejected', !evaluate({ title: 'Senior Backend Engineer' }).pass);
check('sr. rejected', !evaluate({ title: 'Sr. Software Engineer' }).pass);
check('staff rejected', !evaluate({ title: 'Staff Engineer' }).pass);
check('principal rejected', !evaluate({ title: 'Principal Engineer' }).pass);
check('manager rejected', !evaluate({ title: 'Engineering Manager' }).pass);
check('director rejected', !evaluate({ title: 'Director of Engineering' }).pass);
check('intermediate kept', evaluate({ title: 'Intermediate Backend Engineer' }).pass);
check('SDE-1 kept', evaluate({ title: 'Software Engineer I, Backend' }).pass);

console.log('Location eligibility');
// "Remote U.S." passed on the first pass — the pattern only caught the long forms.
check('Remote U.S. rejected', !filter.isIndiaEligible('Remote U.S.'));
check('US Remote rejected', !filter.isIndiaEligible('US Remote'));
check('Remote, United States rejected', !filter.isIndiaEligible('Remote, United States'));
check('Remote, Canada rejected', !filter.isIndiaEligible('Remote, Canada'));
check('Remote, EMEA rejected', !filter.isIndiaEligible('Remote, EMEA'));
check('San Francisco rejected', !filter.isIndiaEligible('San Francisco, California'));
check('Remote, India accepted', filter.isIndiaEligible('Remote, India'));
check('bare Remote accepted', filter.isIndiaEligible('Remote'));
check('Bengaluru accepted', filter.isIndiaEligible('Bengaluru, Karnataka, India'));
check('Bangalore accepted', filter.isIndiaEligible('Bangalore'));
check('unstated accepted', filter.isIndiaEligible(null));

console.log('Experience extraction');
check('3+ years', filter.extractMinYears('We need 3+ years of experience') === 3);
check('2-4 years', filter.extractMinYears('2-4 years experience required') === 2);
check('minimum phrasing', filter.extractMinYears('Minimum 5 years in backend') === 5);
// "3+ years backend, 5+ preferred" is still open to a 3-year candidate.
check('takes the lowest', filter.extractMinYears('3+ years required, 5+ years preferred') === 3);
check('unstated is null', filter.extractMinYears('We want a great engineer') === null);
check('ignores large numbers', filter.extractMinYears('Serving customers for 30 years') === null
  || filter.extractMinYears('Serving customers for 30 years') <= 15);

console.log('Skill matching');
check('counts matches', filter.countSkillMatches('We use Java and Go', ['Java', 'Go', 'Rust']) === 2);
check('case insensitive', filter.countSkillMatches('JAVA and spring boot', ['Java', 'Spring Boot']) === 2);
// "Go" and "Golang" in one posting is one skill, not two.
check('dedups go/golang', filter.countSkillMatches('Go and Golang', ['Go', 'Golang']) === 1);
check('empty description', filter.countSkillMatches('', ['Java']) === 0);

console.log('Full evaluation');
check('good job passes', evaluate({}).pass);
check('too few skills rejected', !evaluate({ description: 'We use Rust exclusively' }).pass);
check('stale posting rejected',
  !evaluate({ posted_at: new Date(Date.now() - 60 * 86400000).toISOString() }).pass);
check('too many years rejected',
  !evaluate({ description: 'Java Spring Boot PostgreSQL REST. 8+ years of experience required.' }).pass);
check('unrelated title rejected', !evaluate({ title: 'Chef de Partie' }).pass);
check('rejection carries a reason', typeof evaluate({ title: 'Senior Engineer' }).reason === 'string');
check('pass carries signals', typeof evaluate({}).signals.skillMatches === 'number');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
