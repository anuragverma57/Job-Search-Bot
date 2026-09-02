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

*(collector quirks, board URL formats, response shapes)*

---

## Phase 6

*(per-platform form quirks — expect this section to get long)*
