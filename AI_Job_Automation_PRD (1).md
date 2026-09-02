# Product Requirements Document (PRD)

# AI Job Application Automation Bot

## Overview

Build a personal automation tool that continuously discovers relevant software engineering jobs, evaluates them using AI, prepares applications, and submits them where safe to do so. The goal is to eliminate repetitive job application work so the user can focus on interview preparation, referrals, and follow-ups.

This project is intended for personal use and is **not** designed as a commercial SaaS product.

---

# Primary Goal

Do 90% of the application work automatically and leave the user a short morning review.

Success means waking up to a small queue of prepared applications that can be approved in five minutes, plus an accurate record of where the user has applied and who needs a follow-up.

The bot buys back time spent on data entry. It is explicitly **not** a volume lottery — the reclaimed time is meant to be spent on referrals, targeted applications, and interview prep.

---

# Non-Goals

- Building a startup or SaaS
- Multi-user support
- Enterprise scalability
- Distributed microservices
- Complex AI agent frameworks
- Career coaching features
- Automated outreach, cold emailing, or recruiter contact discovery
- Fully unattended submission to companies the user actually cares about

---

# Guiding Principles

- Keep the architecture simple.
- Prefer deterministic automation over autonomous reasoning.
- Use AI only where it adds meaningful value.
- Minimize infrastructure and operational overhead.
- Optimize for maintainability.
- Fail loudly and visibly, never silently.
- A bad application is worse than no application — you only get one shot per company.
- Never fabricate anything about the user's experience.

---

# High-Level Workflow

1. Discover new jobs.
2. Deduplicate against everything already seen.
3. Filter jobs based on predefined preferences (cheap, deterministic).
4. Evaluate the survivors using AI and produce a score plus a reason.
5. Prepare application materials and pre-fill the application form.
6. Submit automatically where allowed, otherwise park for approval.
7. Record application history and verify the submission actually landed.
8. Notify the user with a summary.
9. Repeat on a schedule.

---

# Target Platforms

## Tier 1 — apply automatically (v1)

These are ATS form endpoints. They generally require no login, so there is no
account to lose. This is where automated submission happens.

- Greenhouse
- Lever
- Ashby

## Tier 2 — discovery only

Automating these violates their terms of service and risks a permanent ban on
the user's real professional identity. The bot may read public listings to
discover jobs, but never logs in and never submits. Applications to these are
done by hand.

- Wellfound
- LinkedIn
- Naukri

This split is a deliberate decision, not a limitation to be removed later
without reconsidering the risk.

---

# Core Features

## Job Discovery

- Periodically search supported platforms.
- Detect new opportunities.
- Avoid duplicate processing.

### Deduplication

The same role frequently appears on several boards under different URLs. URLs
alone are not a sufficient key.

- Canonical key: normalized company name + normalized title + normalized location.
- Normalization strips punctuation, case, legal suffixes (Inc, Ltd, Pvt),
  and common title noise (seniority markers are kept, "(Remote)" is not).
- The raw URL is stored too, but the canonical key decides "have I seen this".
- A job already applied to is never re-processed, regardless of source.

## Filtering

A cheap deterministic pass runs before any AI call: keyword match, experience
range, location/remote, and the company blocklist. Only survivors reach the AI.
This keeps cost bounded and is the main lever for tuning result quality.

## AI Evaluation

- Evaluate relevance of each shortlisted job.
- Produce a suitability score (0-10) and a one-line human-readable reason.
- Produce an application recommendation.

The reason string is required — a score with no explanation cannot be tuned.

## Resume Support

- Maintain a master resume as structured data (the single source of truth).
- Generate tailored resumes by reordering and rewording existing content.

### Truthfulness constraint (hard rule)

Tailoring may **only** reorder, reword, or omit content that already exists in
the master resume. It may never add a skill, technology, employer, date,
metric, or claim that is not already there. A fabricated resume is worse than
no application and is a real professional risk.

Rendering uses a fixed template (HTML or LaTeX) to PDF. The LLM never produces
layout, only text content that fills the template — ATS parsers mangle
free-form generated documents.

## Cover Letter Support

- Generate customized cover letters when required by the form.
- Same truthfulness constraint as resumes.
- Skip when the field is optional; a generic AI cover letter adds little and
  is increasingly recognizable.

## Application Preparation and Submission

- Complete supported application flows.
- Upload documents.
- Fill supported application fields from the answer bank.
- Verify the submission actually succeeded before recording it.
- Record submission results.

### Answer bank

A config-driven store of standard answers, since these repeat on nearly every
form:

- Work authorization / visa sponsorship required
- Notice period
- Current and expected compensation
- Willingness to relocate
- Years of experience with specific technologies
- Links (LinkedIn, GitHub, portfolio)
- EEO / demographic questions (with a "prefer not to say" default)

Any question not covered by the answer bank routes the application to the
manual queue. The bot never guesses an answer on the user's behalf.

### Submission verification

A click that did not throw is **not** proof of submission. After submitting,
the bot must confirm success via a positive signal — a confirmation page,
success text, or a redirect to a known thank-you URL. A screenshot is saved
for every submission attempt regardless of outcome. Without positive
confirmation the status is `failed`, never `applied`.

## Tracking

Maintain history of:

- Jobs discovered
- Applications submitted
- Platform
- Company
- Status
- Resume version used
- Contact email, when one is genuinely known
- Timestamps (discovered, applied, last status change, followed up)

## Dashboard

A single locally served HTML page (`localhost`), rendered server-side from
SQLite. No build step, no client framework, no authentication, no API layer.

Sections, in build order:

1. **Summary strip** — applied this week, awaiting response, follow-ups due,
   responses received.
2. **Recent applications** — last ~30: date, company, role, platform, status,
   resume version. Answers "did I already apply here?" and "what did I send?".
3. **Pending approval** — applications the bot prepared, with score and reason,
   checkboxes, and a single approve action. This is what makes the dashboard
   part of the daily loop.
4. **Follow-ups due** — applied 7+ days ago with no response. Includes a
   `mailto:` draft button when a real contact email is known, and a "mark
   followed up" action.
5. **Needs attention** — failures and unknown questions, with reasons.

Explicitly excluded: charts, funnel visualizations, analytics pages, calendar
integration, rich-text notes. Add only if genuinely missed later.

## Notifications

Not optional and not deferred. A scheduled bot without notifications is a bot
whose breakage goes unnoticed. One summary message per run via Telegram (or
email), containing counts, the prepared-application list, and any failures.

---

# Safety and Controls

These exist because the bot acts irreversibly in the real world on the user's
behalf. Every one of them is a v1 requirement.

- **Dry-run mode** — performs the entire flow except the final submit click.
  This is the **default**. Live submission requires explicit opt-in via config.
- **Daily cap** — `MAX_APPLICATIONS_PER_DAY` (default 10). Hard stop, not a
  warning.
- **Company blocklist** — companies the user wants to apply to personally.
  The bot never submits to these; it surfaces them for manual handling.
- **Approval queue** — the default path for prepared applications. Auto-submit
  may be enabled per-tier once the user trusts the system, but manual approval
  remains the default for any company on the watchlist.
- **Kill switch** — a single flag or file that stops all submission immediately
  without needing to stop the process or edit code.
- **Rate limiting** — human-plausible delays between actions. Never hammer a
  target site.

# Failure Handling

Every failure routes somewhere visible. Nothing fails silently.

| Failure | Behavior |
|---|---|
| Selector not found / DOM changed | Abort this application, screenshot, mark `failed` with the selector name, notify. Three consecutive failures on one platform escalate to a "platform broken" alert. |
| Unknown or unanswerable question | Do not guess. Route to `needs_manual` with the question text captured so it can be added to the answer bank. |
| CAPTCHA or email verification | Fail fast to `needs_manual`. No solving, no bypassing. |
| Submission unconfirmed | Status `failed`, never `applied`. Screenshot retained. |
| AI evaluation error / malformed output | Skip the job, leave it for the next run. Never submit on an unparsed response. |
| Network or timeout | Retry once with backoff, then `failed`. |

Screenshots are retained for every submission attempt and every failure — they
are the primary debugging artifact when a form silently changes.

# Status Model

```
discovered → filtered_out
           → shortlisted → prepared → applied → responded → interviewing → offer
                                            ↘ rejected
                                            ↘ ghosted
                        ↘ needs_manual
                        ↘ failed
```

- `applied` requires positive submission confirmation.
- `ghosted` is set automatically after 30 days of silence, so the
  "awaiting response" count stays honest.
- `responded` onward is set manually by the user from the dashboard.

# Cost Controls

- A cheap model handles the initial relevance pass; the more capable model is
  reserved for the shortlist and for generating materials.
- Monthly spend cap in config; the bot stops calling the API when reached and
  notifies.
- Token usage is logged per run.

# Security

- All credentials and API keys live in `.env`, which is gitignored from the
  first commit. The repository is going to GitHub — an accidental credential
  commit is the single most damaging mistake available here.
- No credentials in the database, in logs, or in screenshots.
- Tier 2 platform credentials are not stored at all, since the bot never logs
  into them.

# Technology Stack

Runtime:

- Node.js

Browser Automation:

- Playwright

Database:

- SQLite

AI:

- OpenAI API

Containerization:

- Docker

Version Control:

- GitHub

---

# Architecture

A single Node.js application with modular components.

Suggested modules:

- Scheduler
- Collectors (one per platform, shared interface)
- Filter (deterministic pre-AI pass)
- AI (evaluation + content generation)
- Resume (master data, tailoring, PDF rendering)
- Application (form filling, answer bank, submission, verification)
- Database
- Dashboard (server-rendered HTML)
- Notifier
- Configuration
- Logging
- Utilities

---

# Persistence

Use SQLite as the primary database.

The database should persist using Docker volumes.

---

# Scheduling

The application runs automatically on a configurable schedule.

---

# Configuration

Store configurable values outside application code, including:

- Preferred technologies
- Experience
- Salary expectations
- Resume locations
- API keys
- Platform credentials
- Search preferences

---

# Logging

Maintain logs for:

- Job discovery
- AI evaluation
- Application attempts
- Errors
- System events

---

# Docker

Docker is **deferred until after v1 works**. Playwright in Docker adds a large
image and browser dependency management for no benefit while the target is a
single laptop. Build and run with plain Node first; containerize later if the
repeatability is actually wanted.

When added: persistent data must survive container recreation via volumes.

---

# Deployment

Primary deployment target:

- Personal laptop, scheduled via cron or launchd.

Cloud deployment is optional and not required for the initial version.

---

# Definition of Done (v1)

v1 is complete when, unattended overnight:

1. The bot discovers jobs from Greenhouse, Lever, and Ashby.
2. It deduplicates them correctly against previously seen jobs.
3. It scores them and records a reason for each score.
4. It prepares at least 5 applications end-to-end and submits them with
   verified confirmation, without an unhandled error.
5. It sends one summary notification.
6. The dashboard accurately shows what was applied to and what needs follow-up.

Anything beyond this is v2. Scope creep here is the main risk to the project
ever being finished.

---

# Design Philosophy

- One application
- One repository
- Simple architecture
- Easy to maintain
- Low operating cost

---

# Future Enhancements

Potential future additions:

- Docker packaging
- Additional job platforms
- Response-rate analytics once there is enough data to be meaningful
- Auto-submit expansion as trust in the system grows
- PostgreSQL migration if ever needed

Deliberately **not** future work:

- Recruiter contact discovery, email scraping, or cold outreach. Contact
  emails are stored only when the user legitimately obtains one (e.g. a
  recruiter emailed first). Guessing addresses burns the user's personal
  email reputation and produces bounces; scraping LinkedIn risks the ban this
  design exists to avoid. The bot drafts follow-ups via `mailto:`; the user
  sends them.

---

# Out of Scope

- Microservices
- Kubernetes
- Event-driven architecture
- Multi-user authentication
- Team collaboration
- SaaS billing
- Marketplace integrations
