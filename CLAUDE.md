# CLAUDE.md

Guidance for AI agents working in this repository. Read this before writing code.

---

## What this is

A **personal** job application automation tool. One user, one laptop. It
discovers software engineering jobs from ATS boards, scores them with AI,
prepares applications, and submits them after the user approves.

Read `AI_Job_Automation_PRD (1).md` for requirements and `PHASES.md` for build
order. This file exists to prevent common wrong turns.

---

## What this is NOT

Do not build, suggest, or scaffold any of the following. They have been
explicitly rejected:

- A SaaS, startup, or anything multi-user
- Authentication, user accounts, roles, or tenancy
- Microservices, message queues, event buses, Kubernetes
- A React/Vue/Svelte frontend, or any frontend build step
- An agent framework (LangChain, AutoGPT, CrewAI, etc.)
- A REST API layer for the dashboard
- Analytics, funnel charts, or data visualization
- Email sending, SMTP, cold outreach, or recruiter contact scraping
- Postgres, Redis, or any service beyond SQLite

If a task seems to call for one of these, the task is wrong — say so rather
than building it.

---

## Non-negotiable rules

These encode decisions already made. Do not relax them without the user
explicitly saying so in the current conversation.

### 1. Dry run is the default

`DRY_RUN=true` unless explicitly overridden. Never change the default. Never
add a code path that submits while dry run is on.

### 2. Never fabricate resume content

Tailoring may only reorder, reword, or omit content that already exists in the
master resume JSON. Never add a skill, technology, employer, date, metric, or
achievement that isn't in the source. This is a professional-integrity issue,
not a style preference. Enforce it in prompts *and* verify in code.

### 3. Never guess an application answer

If a form question isn't in the answer bank, route the application to
`needs_manual` and capture the question text. Do not have the LLM invent an
answer. Wrong answers to work-authorization or compensation questions cause
real harm.

### 4. A click is not a confirmation

Submission is only `applied` after a positive success signal — confirmation
page, success text, or a known thank-you redirect. Absent that, status is
`failed`. Never mark applied because no exception was thrown.

### 5. Tier 1 vs Tier 2 platforms

- **Tier 1 (Greenhouse, Lever, Ashby):** no login, automated submission allowed.
- **Tier 2 (Wellfound, LinkedIn, Naukri):** discovery only. Never log in,
  never submit, never store credentials. Automating these risks a permanent
  ban on the user's real professional identity.

Do not add login flows for Tier 2 platforms.

### 6. No CAPTCHA solving or detection evasion

Hit a CAPTCHA or verification wall → fail fast to `needs_manual`. Do not
integrate solving services, do not fingerprint-spoof beyond ordinary
human-plausible pacing.

### 7. Secrets never enter git

`.env` is gitignored from commit one. No credentials in the database, in logs,
in screenshots, or in committed config. This repo goes to GitHub.

### 8. Caps are hard stops

`MAX_APPLICATIONS_PER_DAY` and the monthly AI spend cap stop execution. They
are not warnings to log and continue past.

---

## Architecture

Single Node.js app, modular files, no framework ceremony.

```
src/
  index.js          entry + CLI dispatch
  scheduler.js      cron
  config.js         env + config.json
  db/               schema, migrations, queries
  collectors/       greenhouse.js, lever.js, ashby.js — shared interface
  filter.js         deterministic pre-AI filter
  ai/               evaluate.js, generate.js
  resume/           master.json, template, render.js
  application/      fill.js, answers.js, submit.js, verify.js
  dashboard/        server.js + server-rendered HTML
  notifier.js       telegram or email
  logger.js
data/               SQLite (gitignored)
screenshots/        submission evidence (gitignored)
```

**Stack:** Node.js · Playwright · SQLite (`better-sqlite3`) · Express
(dashboard only) · OpenAI API · plain HTML/CSS.

Docker is deferred until after v1. Don't add it.

---

## Conventions

- Plain JavaScript, not TypeScript. CommonJS or ESM — match what exists.
- `better-sqlite3` synchronous API. No ORM.
- Every module gets its own file; no barrel exports.
- Collectors implement `search(criteria) -> Job[]` and nothing else.
- Errors are logged with context and routed to a visible status. Never
  swallow an exception.
- Screenshots on every submission attempt, success or failure.

---

## The status model

```
discovered → filtered_out
           → shortlisted → prepared → applied → responded → interviewing → offer
                                            ↘ rejected
                                            ↘ ghosted
                        ↘ needs_manual
                        ↘ failed
```

`applied` requires confirmation. `ghosted` is automatic after 30 days.
`responded` onward is set by the user from the dashboard.

---

## Deduplication

The canonical key is normalized **company + title + location**, not the URL.
The same role appears on multiple boards with different URLs. Normalization
strips case, punctuation, legal suffixes (Inc/Ltd/Pvt), and title noise like
"(Remote)" — but preserves seniority markers, since "Senior" vs "Staff" are
different jobs.

---

## Dashboard rules

Server-rendered HTML from Express. No client framework, no build step, no API
layer, no auth. It binds to localhost only.

Sections: summary strip · recent applications · pending approval · follow-ups
due · needs attention. That's the complete list — do not add charts or extra
pages.

---

## Working style

- **Follow `PHASES.md` in order.** Each phase must work before the next starts.
- Prefer deterministic code over AI calls. AI is for scoring and content
  generation only — never for control flow, navigation, or decisions with
  real-world consequences.
- Keep it boring. This is a tool the user maintains alone in their spare time.
  Clever abstractions are a liability.
- When something breaks in browser automation, the fix is usually a selector,
  not an architecture change.
- If a change would expand scope beyond the PRD's v1 Definition of Done, flag
  it rather than building it.

---

## Common wrong turns

| Temptation | Why it's wrong |
|---|---|
| "Let the LLM navigate the form" | Non-deterministic, expensive, unverifiable. Use selectors. |
| "Add retries so it always succeeds" | Masks selector rot. Fail loudly instead. |
| "Auto-answer unknown questions" | Produces false statements on real applications. |
| "Add a React dashboard" | Explicitly rejected. Server-rendered HTML only. |
| "Scrape LinkedIn for recruiter emails" | Ban risk + bounces + spam flagging. Rejected. |
| "Mark applied after the click" | Silent data corruption. Verify first. |
| "Containerize it first" | Deferred. Ship v1 on plain Node. |
