'use strict';

/**
 * Dedup regression suite. Run: npm test
 *
 * The canonical key is the heart of Phase 1 — over-collapsing silently hides
 * jobs, under-collapsing causes duplicate applications. Both are expensive and
 * neither is visible without these assertions.
 */

const {
  canonicalKey,
  normalizeCompany,
  normalizeTitle,
  normalizeLocation,
  htmlToText,
  toIsoDate,
} = require('../src/collectors/normalize');

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

function sameJob(name, a, b) {
  check(name, canonicalKey(...a) === canonicalKey(...b));
}

function differentJob(name, a, b) {
  check(name, canonicalKey(...a) !== canonicalKey(...b));
}

console.log('Dedup: must collapse');
sameJob('legal suffix', ['Acme Inc', 'Backend Engineer', 'Bangalore'], ['Acme', 'Backend Engineer', 'Bangalore']);
sameJob('pvt ltd chain', ['Zeta Technologies Pvt Ltd', 'SDE 2', 'Bangalore'], ['Zeta', 'SDE 2', 'Bangalore']);
sameJob('city alias', ['X', 'Backend Engineer', 'Bengaluru'], ['X', 'Backend Engineer', 'Bangalore']);
sameJob('roman vs digit', ['X', 'SDE II', 'Remote'], ['X', 'SDE 2', 'Remote']);
sameJob('remote marker in title', ['X', 'Backend Engineer (Remote)', 'Remote'], ['X', 'Backend Engineer', 'Remote']);
sameJob('req id suffix', ['X', 'Backend Engineer JR-4471', 'Pune'], ['X', 'Backend Engineer', 'Pune']);
sameJob('case and punctuation', ['ACME!', 'Back-End Engineer', 'Mumbai'], ['acme', 'Back End Engineer', 'Mumbai']);
sameJob('location precision', ['X', 'Backend Engineer', 'Bengaluru-VTP, India'], ['X', 'Backend Engineer', 'Bangalore, KA']);
sameJob('gendered title suffix', ['X', 'Backend Engineer (m/w/d)', 'Berlin'], ['X', 'Backend Engineer', 'Berlin']);
sameJob('multi-region same first', ['X', 'Eng', 'Remote Ireland; Remote, Denmark'], ['X', 'Eng', 'Remote Ireland; Remote, Austria']);

console.log('Dedup: must NOT collapse');
differentJob('Senior vs Staff', ['X', 'Senior Engineer', 'Blr'], ['X', 'Staff Engineer', 'Blr']);
differentJob('SDE2 vs SDE3', ['X', 'SDE 2', 'Blr'], ['X', 'SDE 3', 'Blr']);
differentJob('different city', ['X', 'Backend Engineer', 'Bangalore'], ['X', 'Backend Engineer', 'Pune']);
differentJob('remote vs onsite', ['X', 'Backend Engineer', 'Remote'], ['X', 'Backend Engineer', 'Bangalore']);
differentJob('backend vs frontend', ['X', 'Backend Engineer', 'Blr'], ['X', 'Frontend Engineer', 'Blr']);
differentJob('different company', ['Acme', 'Backend Engineer', 'Blr'], ['Beta', 'Backend Engineer', 'Blr']);
differentJob('seniority prefix', ['X', 'Senior Backend Engineer', 'Blr'], ['X', 'Backend Engineer', 'Blr']);
differentJob('remote regions differ', ['X', 'Eng', 'Remote, North America'], ['X', 'Eng', 'Remote, Australia']);

console.log('Normalizers');
check('company strips suffix', normalizeCompany('Acme Technologies Pvt. Ltd.') === 'acme');
check('title keeps seniority', normalizeTitle('Senior Engineer').includes('senior'));
check('bare remote', normalizeLocation('Remote') === 'remote');
check('remote india', normalizeLocation('Remote, India') === 'remote india');
check('empty location', normalizeLocation('') === 'unspecified');

console.log('HTML decoding');
check('double-encoded (Greenhouse)', htmlToText('&lt;p&gt;R&amp;amp;D team&lt;/p&gt;') === 'R&D team');
check('plain html', htmlToText('<p>Plain &amp; simple</p>') === 'Plain & simple');
check('list items', htmlToText('&lt;li&gt;Java&lt;/li&gt;&lt;li&gt;Spring&lt;/li&gt;').includes('• Java'));
check('null passthrough', htmlToText(null) === null);
check('script stripped', !htmlToText('<script>bad()</script><p>ok</p>').includes('bad'));

console.log('Dates');
check('epoch millis', toIsoDate(1782214185805).startsWith('2026'));
check('iso string', toIsoDate('2026-08-27T07:35:34-04:00').startsWith('2026-08-27'));
check('date only', toIsoDate('2025-11-14').startsWith('2025-11-14'));
check('invalid is null', toIsoDate('not a date') === null);
check('null is null', toIsoDate(null) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
