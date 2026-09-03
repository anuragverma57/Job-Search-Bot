# Notes

Things learned while building that don't belong in the plan. Append freely.

---

## Phase 0

- `better-sqlite3` 12.x compiles cleanly on Node 24 / macOS ARM — no build
  tools needed, prebuilt binary.
- WAL mode is on, so the dashboard can read while a run writes. This is why
  `data/` holds `.db-wal` and `.db-shm` alongside the `.db` — all gitignored.
- Status vocabularies live in SQL `CHECK` constraints, not just in JS. A typo
  like `status = 'aplied'` throws at write time instead of creating a status
  nothing queries. Adding a status means editing `schema.sql`.
- `applications` has a **partial** unique index: one live application per job,
  but `failed` and `needs_manual` rows are excluded so a broken attempt can be
  retried. Verified.
- `countApplicationsToday()` counts `dry_run = 0` only. Dry runs never consume
  the daily quota — otherwise testing would exhaust it.
- `DRY_RUN` is string-parsed as "anything that isn't literally `false` is
  true". A typo (`DRY_RUN=flase`) fails safe rather than enabling submission.
- The kill switch is checked at call time via `config.isKillSwitchActive()`,
  not read once at startup — so `touch STOP` halts a run already in progress.
- Deps are added per-phase rather than all up front (Playwright in 6, Express
  in 2, OpenAI in 3). Keeps a failed install traceable to one phase.

---

## Phase 1

### API endpoints (all public, no auth, no login)

- **Greenhouse:** `GET boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
  One call per board, descriptions included. Cleanest of the three.
  Note `boards.greenhouse.io` / `job-boards.greenhouse.io` are UI hosts —
  the API host is `boards-api`.
- **Lever:** `GET api.lever.co/v0/postings/{slug}?mode=json`
  Flat array, plaintext descriptions included.
- **Ashby:** `POST jobs.ashbyhq.com/api/non-user-graphql` (GraphQL).
  Two calls needed — see below.

### Slugs are not company names

Roughly half the guessed slugs 404'd. Verified live:

- Greenhouse: `groww`, `postman`, `gitlab`, `stripe`
- Lever: `cred`, `zeta`, `meesho`, `spotify`
- Ashby: `ramp`, `vanta`, `linear`

**Dead (company not on that platform):** razorpay, freshworks, atlassian,
notion on Greenhouse; netflix, box, plaid on Lever; mercury/deel on Ashby
(valid board, zero postings).

**cred, zeta, freshworks and meesho are on Lever, not Greenhouse** — worth
checking all three platforms before writing a slug off. Dead slugs are
reported, never fatal: a company migrating ATS should not break a run.

### Greenhouse double-encodes HTML

`content` arrives as `&lt;div&gt;...` — entities must be decoded BEFORE tag
stripping, then the decode/strip pair runs a second time. `&amp;` must be
decoded LAST or `&amp;lt;` wrongly becomes `<`. This cost a debugging cycle.

### Ashby specifics

- Introspection is disabled, so field names were found by probing.
- The description field is **`descriptionHtml`** — `descriptionPlain`,
  `description`, and `descriptionPlainText` are all rejected.
- The board query returns only brief fields (no description, date, or URL),
  so details need a second call per posting — the only N+1 collector. A
  loose title pre-filter limits how many details get fetched.
- Job URL is `jobs.ashbyhq.com/{slug}/{postingId}` (constructed, not returned).

### Dedup: remote regions must be preserved

First pass collapsed "Remote, North America" and "Remote, Australia" into
`remote`, merging jobs that cannot be applied to interchangeably. Fixed by
keeping the first named region: `remote north america`. This recovered 20
jobs (1093 -> 1113). Multi-region postings list regions in varying order, so
only the FIRST is used — otherwise ordering differences defeat dedup.

### Real numbers (first full run)

1113 jobs: greenhouse 857, lever 159, ashby 77. ~110s for 11 boards.
100% completeness on description, posted_at, and location.
66 jobs mention backend/Java/Spring Boot.

Within a single run, 21 duplicates were caught — mostly GitLab posting the
same role across regional listings. That is correct behaviour.

### Test suite

`npm test` runs `test/normalize.test.js` (33 assertions). Dedup is the easiest
thing to silently break; over-collapsing hides jobs, under-collapsing causes
duplicate applications, and neither is visible without assertions. Add a case
here whenever a new collapse/no-collapse rule is discovered.

---

## Phase 2

### Default sort must be posting date, not discovery date

A whole discovery run shares one `discovered_at` value — 1113 rows across only
3 distinct timestamps on the first run. Ordering by it leaves each batch in
arbitrary order, so the landing page filled with Linear postings 4-5 years old
while GitLab's India backend roles posted *today* sat on page 12. Default sort
is now `posted DESC`. Worth remembering: any "newest" ordering keyed on when
*we* saw something will be wrong for batch inserts.

### Stale postings are real

Ashby boards in particular carry postings years old (Linear has several from
2021). The `maxAgeDays` filter matters more than expected — the useful default
view is really "backend + India + last 30 days", which returns 12 jobs out of
1113.

### Server binds to 127.0.0.1 explicitly

`app.listen(port)` alone binds 0.0.0.0 and exposes an unauthenticated page to
the whole local network. Passing `'127.0.0.1'` as the host is what keeps it
local; verified with `lsof` and by trying the LAN IP.

### Killing a backgrounded server between Bash calls

`kill %1` does not work — each Bash tool call is a fresh shell with no job
table. Use `pkill -f "node src/index.js dashboard"`. Two "fixes" appeared to
fail because the old process was still serving cached code.

---

## Phase 3 — board coverage is the real ceiling

Probed ~155 slugs (70 plain names + 85 variants like `razorpaysoftware`,
`bundltechnologies`, `mohallatech`) across all three ATS platforms. **One hit**,
and it was a name collision: `ashby/navi` is a San Francisco hardware startup,
not Navi the Indian fintech.

The method was verified against known-good slugs (groww, postman, gitlab,
stripe, cred, zeta, meesho all still return 200), so this is a real finding.

**Why:** Razorpay, PhonePe, Swiggy, Zomato, Flipkart and Groww all run careers
pages on their own domains with no Greenhouse/Lever/Ashby markers in the HTML.
Indian product companies overwhelmingly use Darwinbox, Keka, Zoho Recruit,
SmartRecruiters, or in-house portals — none of which expose a public JSON API
the way the Tier 1 three do.

**Consequence:** Tier 1 coverage for India-based backend roles is structurally
thin. The pipeline is working correctly; there is simply little to find. Options,
in order of value:

1. Add more *global* boards that hire India-remote (the current set is only 11).
2. Accept that Tier 1 is a supplement, and use Tier 2 (Naukri/LinkedIn)
   discovery-only for the Indian market, applying by hand.
3. Write per-company collectors for Darwinbox/Keka tenants — real work, and
   each one is bespoke.

Do NOT respond to this by loosening the filter. The filter is correct; the
input is thin.

---

## Phase 6

*(per-platform form quirks — expect this section to get long)*
