'use strict';

/**
 * Server-rendered HTML. No client framework, no build step, no API layer —
 * one page, plain CSS, a few links. See CLAUDE.md.
 */

/** Every interpolated value passes through this. Job text comes from the web. */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function daysAgo(isoDate) {
  if (!isoDate) return null;
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
}

function relativeDate(isoDate) {
  const days = daysAgo(isoDate);
  if (days === null) return '—';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const STYLES = `
:root {
  --bg: #fbfbfa; --panel: #fff; --border: #e4e4e1; --text: #1a1a19;
  --muted: #6b6b66; --accent: #2f6f4f; --warn: #b45309; --danger: #b91c1c;
  --chip: #f1f1ee;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171a; --panel: #1e1e22; --border: #2f2f35; --text: #e8e8e6;
    --muted: #9a9a94; --accent: #6ea587; --warn: #d99a3a; --danger: #e07070;
    --chip: #26262b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 60px; }
header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
h1 { font-size: 19px; margin: 0; font-weight: 600; }
.sub { color: var(--muted); font-size: 12.5px; margin-bottom: 22px; }
.banner {
  background: var(--chip); border-left: 3px solid var(--warn);
  padding: 9px 13px; border-radius: 4px; margin-bottom: 18px; font-size: 13px;
}
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 26px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 7px; padding: 12px 14px; }
.stat .n { font-size: 23px; font-weight: 600; line-height: 1.1; }
.stat .l { color: var(--muted); font-size: 11.5px; margin-top: 3px; text-transform: uppercase; letter-spacing: .03em; }
.stat.alert .n { color: var(--warn); }
h2 { font-size: 14px; font-weight: 600; margin: 26px 0 10px; }
h2 .count { color: var(--muted); font-weight: 400; }
form.filters {
  display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 7px; padding: 11px;
}
input[type=search], select {
  background: var(--bg); color: var(--text); border: 1px solid var(--border);
  border-radius: 5px; padding: 6px 9px; font-size: 13px; font-family: inherit;
}
input[type=search] { flex: 1 1 220px; min-width: 0; }
button {
  background: var(--accent); color: #fff; border: 0; border-radius: 5px;
  padding: 6px 14px; font-size: 13px; cursor: pointer; font-family: inherit;
}
button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; padding: 9px 12px; font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 600;
  white-space: nowrap;
}
td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: var(--chip); }
a { color: inherit; text-decoration: none; }
a.title { font-weight: 500; }
a.title:hover { text-decoration: underline; color: var(--accent); }
.company { color: var(--muted); }
.nowrap { white-space: nowrap; color: var(--muted); font-size: 12.5px; }
.chip {
  display: inline-block; background: var(--chip); border-radius: 4px;
  padding: 1px 7px; font-size: 11px; color: var(--muted); white-space: nowrap;
}
.chip.old { color: var(--warn); }
.score { font-weight: 600; }
.empty { padding: 30px 14px; text-align: center; color: var(--muted); font-size: 13px; }
.pager { display: flex; gap: 8px; align-items: center; margin-top: 12px; font-size: 13px; color: var(--muted); }
.pager a { border: 1px solid var(--border); border-radius: 5px; padding: 5px 11px; background: var(--panel); }
.pager a:hover { border-color: var(--accent); color: var(--accent); }
.health { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 22px; }
.health .p { font-size: 12px; padding: 4px 10px; border-radius: 5px; background: var(--panel); border: 1px solid var(--border); }
.health .p.bad { border-color: var(--danger); color: var(--danger); }
footer { margin-top: 34px; color: var(--muted); font-size: 12px; text-align: center; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

function statCard(number, label, isAlert) {
  return `<div class="stat${isAlert ? ' alert' : ''}"><div class="n">${number}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

function jobRow(job) {
  const age = daysAgo(job.posted_at);
  const isStale = age !== null && age > 30;

  const scoreCell = job.score !== null && job.score !== undefined
    ? `<span class="score">${Number(job.score).toFixed(1)}</span>`
    : '<span class="chip">—</span>';

  const state = job.application_status || job.status;

  return `<tr>
    <td>
      <a class="title" href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a>
      <div class="company">${escapeHtml(job.company)}</div>
    </td>
    <td class="nowrap">${escapeHtml(job.location || '—')}</td>
    <td><span class="chip">${escapeHtml(job.platform)}</span></td>
    <td class="nowrap"><span class="${isStale ? 'chip old' : 'chip'}">${relativeDate(job.posted_at)}</span></td>
    <td>${scoreCell}</td>
    <td><span class="chip">${escapeHtml(state)}</span></td>
  </tr>`;
}

function buildQuery(params, overrides) {
  const merged = { ...params, ...overrides };
  const parts = Object.entries(merged)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function selectField(name, value, options, blankLabel) {
  const items = options
    .map((option) => {
      const optionValue = typeof option === 'string' ? option : option.value;
      const optionLabel = typeof option === 'string' ? option : option.label;
      const selected = String(value) === String(optionValue) ? ' selected' : '';
      return `<option value="${escapeHtml(optionValue)}"${selected}>${escapeHtml(optionLabel)}</option>`;
    })
    .join('');
  return `<select name="${escapeHtml(name)}"><option value="">${escapeHtml(blankLabel)}</option>${items}</select>`;
}

function renderDashboard(data) {
  const { summary, jobs, total, filters, filterOptions, lastRun, health, page, pageSize, dryRun } = data;

  const banner = dryRun
    ? '<div class="banner"><strong>Dry run.</strong> Nothing will be submitted. Set <code>DRY_RUN=false</code> in .env to enable live submission.</div>'
    : '<div class="banner" style="border-left-color:var(--danger)"><strong>Live mode.</strong> Applications will be submitted for real.</div>';

  const stats = [
    statCard(summary.totalJobs, 'jobs found', false),
    statCard(summary.appliedThisWeek, 'applied this week', false),
    statCard(summary.awaitingResponse, 'awaiting reply', false),
    statCard(summary.followUpsDue, 'follow-ups due', summary.followUpsDue > 0),
    statCard(summary.pendingApproval, 'pending approval', summary.pendingApproval > 0),
    statCard(summary.needsAttention, 'needs attention', summary.needsAttention > 0),
  ].join('');

  const healthChips = health.length
    ? `<div class="health">${health
        .map((row) => {
          const bad = row.consecutive_failures >= 3;
          const detail = bad ? `${row.consecutive_failures} failures in a row` : 'ok';
          return `<span class="p${bad ? ' bad' : ''}">${escapeHtml(row.platform)} · ${escapeHtml(detail)}</span>`;
        })
        .join('')}</div>`
    : '';

  const platformOptions = filterOptions.platforms.map((p) => ({
    value: p.platform,
    label: `${p.platform} (${p.count})`,
  }));
  const statusOptions = filterOptions.statuses.map((s) => ({
    value: s.status,
    label: `${s.status} (${s.count})`,
  }));

  const filterForm = `<form class="filters" method="get" action="/">
    <input type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="Search title, company, description…">
    ${selectField('platform', filters.platform, platformOptions, 'All platforms')}
    ${selectField('status', filters.status, statusOptions, 'All statuses')}
    ${selectField('location', filters.location, ['Remote', 'India', 'Bangalore', 'Hyderabad', 'Pune', 'Mumbai'], 'Any location')}
    ${selectField('maxAgeDays', filters.maxAgeDays, [
      { value: '7', label: 'Posted last 7 days' },
      { value: '30', label: 'Posted last 30 days' },
      { value: '90', label: 'Posted last 90 days' },
    ], 'Any age')}
    ${selectField('sort', filters.sort, [
      { value: 'posted', label: 'Newest posted' },
      { value: 'discovered', label: 'Newest found' },
      { value: 'score', label: 'Highest score' },
      { value: 'company', label: 'Company A–Z' },
    ], 'Sort')}
    <button type="submit">Filter</button>
    <a href="/"><button type="button" class="ghost">Reset</button></a>
  </form>`;

  const table = jobs.length
    ? `<div class="panel scroll"><table>
        <thead><tr>
          <th>Role</th><th>Location</th><th>Platform</th><th>Posted</th><th>Score</th><th>Status</th>
        </tr></thead>
        <tbody>${jobs.map(jobRow).join('')}</tbody>
      </table></div>`
    : '<div class="panel"><div class="empty">No jobs match these filters.</div></div>';

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const pager = total > pageSize
    ? `<div class="pager">
        ${page > 1 ? `<a href="${buildQuery(filters, { page: page - 1 })}">← Previous</a>` : ''}
        <span>Page ${page} of ${lastPage} · ${total} jobs</span>
        ${page < lastPage ? `<a href="${buildQuery(filters, { page: page + 1 })}">Next →</a>` : ''}
      </div>`
    : '';

  const lastRunLine = lastRun
    ? `Last discovery ${relativeDate(lastRun.started_at)} · ${lastRun.discovered} new, ${lastRun.duplicates} duplicates`
    : 'No discovery run yet — run <code>npm run discover</code>';

  const body = `
    <header><h1>Job Apply Bot</h1></header>
    <div class="sub">${lastRunLine}</div>
    ${banner}
    <div class="stats">${stats}</div>
    ${healthChips}
    <h2>Jobs <span class="count">${total} matching</span></h2>
    ${filterForm}
    ${table}
    ${pager}
    <footer>Local only · data in SQLite · nothing leaves this machine</footer>`;

  return layout('Job Apply Bot', body);
}

module.exports = { renderDashboard, escapeHtml, relativeDate, layout };
