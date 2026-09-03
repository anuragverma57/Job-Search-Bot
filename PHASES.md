# V1 Build Phases

## Current Status

**Phase:** 6 — Form Filling (DRY RUN ONLY)
**State:** Not started

**Blocked on:** nothing
**Next session:** Greenhouse form filling first, dry-run only, screenshot every attempt

**Done:** Phases 0-4, Phase 5 — resume renders to 1-page PDF matching the LaTeX; tailoring passes a truthfulness gate (90 tests green)

**Before Phase 6:** fill `profile` and `answerBank` in `config.json`

---


Step-by-step build order for the MVP. Each phase produces something that works
on its own and is useful before the next phase exists. Do not start a phase
until the previous one runs end to end.

The ordering principle: **the tracker is useful before the bot works, and the
bot must be safe before it is fast.**

---

## Phase 0 — Foundation

**Goal:** an empty project that runs, stores data, and keeps secrets out of git.

- [x] `npm init` + `better-sqlite3`, `dotenv` (later deps added in the phase that needs them)
- [x] `.gitignore` with `.env`, `data/`, `screenshots/`, `node_modules/` — **before the first commit**
- [x] `.env.example` documenting every key, committed; real `.env` never committed
- [x] `config.js` — loads env + a `config.json` for preferences (keywords, experience range, locations, blocklist, caps)
- [x] SQLite schema and migration runner
- [x] Logger writing to console + rotating file

**Schema (v1):**

```sql
jobs (
  id, canonical_key UNIQUE, platform, company, title, location,
  url, description, salary_text, posted_at, discovered_at, status
)

applications (
  id, job_id, status, resume_version, cover_letter_path,
  applied_at, confirmed, screenshot_path, failure_reason,
  contact_email, followed_up_at, last_status_change
)

ai_evaluations (
  id, job_id, score, reason, model, tokens_used, created_at
)

answer_bank (
  id, question_pattern, answer, created_at
)

runs (
  id, started_at, finished_at, discovered, filtered,
  prepared, submitted, failed, tokens_used
)
```

**Done when:** `npm start` connects to the DB, writes a log line, and exits clean. ✅

*Schema as built differs slightly from the sketch above: `applications` gained
`dry_run`, `confirmation_text`, and `unanswered_question`; `jobs` gained
`filter_reason`; a `platform_health` table was added for consecutive-failure
tracking. See `src/db/schema.sql`.*

---

## Phase 1 — Discovery + Dedup

**Goal:** the bot finds real jobs and never shows you the same one twice.

- [x] Collector interface: `search(slugs, options) -> { jobs, deadSlugs, errors }`
- [x] Greenhouse collector (public JSON API, `content=true` gives descriptions in one call)
- [x] Lever collector (public postings API, plaintext descriptions included)
- [x] Ashby collector (GraphQL, two calls: board list + per-posting detail)
- [x] Canonical key: normalize company (strip Inc/Ltd/Pvt/punctuation/case) + title (keep seniority, drop "(Remote)" noise) + location
- [x] Insert-if-new logic keyed on `canonical_key`
- [x] CLI: `npm run discover`
- [x] Regression suite: `npm test` (33 assertions)

**Done when:** running twice in a row discovers N jobs the first time and 0 the second. ✅
*Verified: run 1 = 1113 new / 21 dup, run 2 = 0 new / 1134 dup.*

**Watch out:** this is where you learn each platform's quirks. Budget more time than you think. Do one platform completely before starting the next.

---

## Phase 2 — Dashboard (read-only)

**Goal:** something useful exists, even though nothing is automated yet.

- [x] Express server on `localhost:3000` (bound to 127.0.0.1, never 0.0.0.0)
- [x] One route, server-rendered HTML, plain CSS, no build step, no framework
- [x] Summary strip: jobs found / applied this week / awaiting / follow-ups due / pending approval / needs attention
- [x] Jobs table: role, company, location, platform, posted age, score, status
- [x] Filters: text search, platform, status, location, posting age, sort
- [x] Pagination (50/page)
- [x] Platform health chips + last-run line
- [x] `npm run dashboard`

**Done when:** you can open the page and see the jobs Phase 1 found. ✅
*Verified: 1113 jobs browsable, filters/pagination/sort all working, XSS and
SQL injection attempts safely handled, loopback-only binding confirmed.*

**Why this early:** it makes every later phase debuggable by eye, and it's genuinely useful on its own — you can already browse discovered jobs instead of trawling boards.

---

## Phase 3 — Filter + AI Evaluation

**Goal:** the list shrinks to jobs actually worth your time.

- [ ] Deterministic pre-filter: keywords, experience range, location/remote, blocklist. Runs **before** any API call.
- [ ] AI evaluation on survivors only → `{ score: 0-10, reason: string }`
- [ ] Use the cheap model here; log tokens per call
- [ ] Monthly spend cap; stop + notify when hit
- [ ] Malformed AI response → skip job, do not crash, retry next run
- [ ] Show score + reason on the dashboard
- [ ] CLI: `npm run evaluate`

**Done when:** you look at the scored list and mostly agree with the ranking. If you don't, tune the filter — not the prompt.

---

## Phase 4 — Notifications

**Goal:** you find out what happened without opening anything.

- [x] Telegram bot (`@Zalco_bot`)
- [x] One summary per run: counts, top matches with score + reason, failures
- [x] Alert on 3 consecutive failures for one platform
- [x] `npm run notify:test` — connection check
- [x] `npm run run:all` — full pipeline: discover → evaluate → notify
- [x] Delivery failure never aborts a run; pipeline errors are themselves notified

**Done when:** a run pings your phone. ✅
*Verified: test message, sample summary, and a real end-to-end run all delivered.*

**Why before submission:** you need visibility in place *before* the bot starts doing irreversible things.

---

## Phase 5 — Resume Pipeline

**Goal:** a correct PDF exists for any job.

- [x] Master resume as structured JSON — the single source of truth
- [x] Fixed HTML template → PDF (Playwright `page.pdf()`), reproducing the LaTeX layout
- [x] Tailoring: reorder and subset only. The model returns bullet IDs and a
      summary variant KEY, never prose — invented text has no channel to the PDF.
- [x] **Hard rule enforced in code, not just the prompt:** `verify()` rejects any
      bullet text, skill, employer, title, date or summary not present verbatim
      in master.json. Failure falls back to the master resume, which is true by
      construction.
- [x] Trim policy: internship bullets are droppable to a floor; the current
      full-time role is protected
- [x] CLI: `npm run resume -- --job <id>` (no `--job` renders the master)
- [x] `npm run test:tailor` — 20 assertions, mostly adversarial

**Done when:** you generate three tailored resumes, read them, and every line is true.
*Rendering and the gate are verified. **The read-them-yourself check is still
yours to do** — see the note below.*

**Watch out:** verify truthfulness by hand at this stage. It's the one failure that damages you professionally, and it's invisible unless you look.

---

## Phase 6 — Form Filling (DRY RUN ONLY)

**Goal:** the bot fills forms perfectly and submits nothing.

- [ ] `DRY_RUN=true` default — everything except the final click
- [ ] Field mapping per platform (name, email, phone, links, resume upload)
- [ ] Answer bank in config; match questions by pattern
- [ ] Unknown question → `needs_manual`, capture the question text verbatim
- [ ] Screenshot before the would-be submit, every time
- [ ] Human-plausible delays between actions
- [ ] CLI: `npm run apply -- --dry-run`

**Done when:** you have reviewed 10+ screenshots of correctly filled forms across all three platforms.

**Do not skip this.** Live for a week here. This is the phase that prevents the disaster.

---

## Phase 7 — Approval Queue + Live Submission

**Goal:** applications actually go out, under your control.

- [ ] Pending-approval section on the dashboard: checkboxes + one approve button
- [ ] Approve → live submit
- [ ] Submission verification: confirmation page / success text / known thank-you redirect. **A click that didn't throw is not confirmation.**
- [ ] Unconfirmed → `failed`, never `applied`
- [ ] `MAX_APPLICATIONS_PER_DAY` hard stop (default 10)
- [ ] Kill switch: a file or flag that halts submission immediately
- [ ] Company blocklist enforced at submit time
- [ ] Screenshot retained for every attempt

**Done when:** 5 applications submitted with verified confirmation, and you can prove each one landed.

---

## Phase 8 — Follow-ups + Status Tracking

**Goal:** nothing gets forgotten.

- [ ] Follow-ups due section: applied 7+ days ago, no response
- [ ] "Mark followed up" action
- [ ] Manual status updates from the dashboard (responded / interviewing / rejected)
- [ ] Auto-set `ghosted` after 30 days of silence
- [ ] `contact_email` column + `mailto:` draft button when one is known
- [ ] Needs-attention section: failures and unknown questions

**Done when:** the dashboard tells you who to nudge today and the mailto opens a pre-filled draft.

---

## Phase 9 — Schedule It

**Goal:** it runs without you.

- [ ] `node-cron` in-process, or a launchd/cron entry
- [ ] Full pipeline: discover → filter → evaluate → prepare → notify
- [ ] Run at 2am and 8am (tune later)
- [ ] Verify it survives sleep/wake and network loss

**Done when:** you wake up to a notification you didn't trigger.

---

## V1 Complete

All Definition-of-Done criteria in the PRD are met. Stop building. Use it for
two weeks, tune the filters, and only then decide what v2 needs — the answer
will be different from what you'd guess today.

---

## Deferred to V2

Docker · additional platforms · Wellfound/LinkedIn discovery-only collectors ·
analytics · auto-submit expansion · Postgres

---

## Post-v1 Backlog

Deferred deliberately — none of it blocks v1, and doing it now would delay the
parts that make the bot actually useful.

### Expand job board coverage (highest value)

Phase 3 revealed the real ceiling: **the filter works, the input is thin.**
Probing ~155 slugs found almost nothing — Indian product companies (Razorpay,
PhonePe, Swiggy, Zomato, Flipkart, Groww) run their own careers portals or use
Darwinbox/Keka/Zoho Recruit, none of which expose a public JSON API.

Options in order of value-per-effort:

1. **More global boards that hire India-remote.** GitLab already proves this
   works — the best-scoring jobs so far are GitLab India roles. Just slugs in
   `config.json`, no code. Candidates worth probing: Automattic, Zapier,
   DuckDuckGo, Toggl, Doist, Grafana, Hashicorp, Elastic, Canonical, Mozilla,
   Sourcegraph, Supabase, PostHog, Railway, Fly.io, Cloudflare, Twilio,
   MongoDB, Confluent, Datadog, DigitalOcean, Vercel, Netlify.
2. **Tier 2 discovery-only for the Indian market.** Naukri/Instahyre/Cutshort/
   Hirist find the jobs, the dashboard tracks them, you apply by hand. No login,
   no submission, no ban risk — consistent with the PRD's Tier 2 rule. This is
   where Indian companies actually post.
3. **Per-company Darwinbox/Keka collectors.** Real work, bespoke per tenant,
   closer to scraping than the clean APIs used so far. Only if 1 and 2 are
   exhausted.

**Do not respond to thin results by loosening the filter.** The filter is
correct; verified against known-answer cases in Phase 3.

### Other deferred items

- Docker packaging
- Response-rate analytics once there is enough data to be meaningful
- Auto-submit expansion as trust in the system grows
- Gmail integration to auto-detect rejections/interviews (Phase 8 does manual
  status updates; this would automate them)
- `mailto:` follow-up drafts where a real contact email is known

---

## Time Expectations

| Phase | Rough effort |
|---|---|
| 0-2 | A weekend — mostly mechanical |
| 3-4 | A few evenings |
| 5 | An evening, plus careful proofreading |
| 6 | The longest phase. Platform quirks live here. |
| 7-9 | A weekend |

Expect week 1 to feel broken, weeks 2-3 to be mostly selector fixes and
answer-bank filling, and month 2 to be steady state at ~30 minutes of
maintenance a month.
