#!/usr/bin/env node

// render-report.js — render the unified security-review HTML report from
// a findings JSON file + the bundled template.
//
// The findings JSON schema is documented in the skill's
// references/orchestration.md ("Findings JSON schema" section). The
// template lives at ../assets/report-template.html; this script replaces
// `__PLACEHOLDER__` tokens in the template with values derived from the
// findings, and writes the result to --output.
//
// This script performs mechanical template substitution only — it does
// NOT generate CSS, reshape data, or make design decisions. Changes to
// the report's visual appearance or section ordering belong in the
// template file.
//
// CLI usage:
//   node render-report.js --findings <path> --output <path> [--dry-run]
//   node render-report.js --help

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
});

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'report-template.html');

const HELP = `Usage:
  render-report.js --findings <path> --output <path> [--dry-run]
  render-report.js --help

Renders the unified security-review HTML report from a findings JSON file
and the bundled template. Performs mechanical token substitution only.

Options:
  --findings <path>  Path to the findings JSON (REQUIRED). See the schema
                     in references/orchestration.md.
  --output <path>    Where to write the HTML report (REQUIRED).
  --dry-run          Validate inputs and compute the rendered byte count,
                     but do NOT write the output file. Prints a JSON
                     summary ({ dryRun, wouldWrite, bytes, severityCounts })
                     to stdout.
  -h, --help         Show this help.

Exit codes:
  0  Success.
  1  Unknown / I/O failure (template missing, write failed, etc.).
  2  Invalid CLI arguments, findings file not found / malformed.
`;

function exitWithMessage(exitCode, message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(exitCode);
}

function invalidArgs(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGS';
  return err;
}

// HTML-escape a value for safe text content. This is NOT sufficient for
// attribute values that contain script-context content — the template is
// intentionally simple (text nodes + attribute values where user input
// is already URL-encoded or numeric).
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSummary(findings) {
  const s = findings.summary || {};
  const bc = s.byCategory || {};
  const categoryRows = Object.entries(bc)
    .map(([cat, count]) => `<li style="display:inline-block;padding:4px 10px;margin:2px 4px 2px 0;background:var(--surface2);border:1px solid var(--border);border-radius:12px;font-size:12px;"><strong style="font-family:var(--mono);color:var(--text-bright);">${escapeHtml(count)}</strong> <span style="color:var(--text-dim);">${escapeHtml(cat)}</span></li>`)
    .join('');
  const total = s.totalFindings ?? 0;
  const byCat = Object.keys(bc).length
    ? `<div style="margin-top:10px;"><div class="field-label">By category</div><ul style="list-style:none;padding:0;margin:6px 0 0;">${categoryRows}</ul></div>`
    : '';
  return `
    <div style="font-size:13px;line-height:1.75;">
      <div>Total findings: <strong style="color:var(--text-bright);">${escapeHtml(total)}</strong></div>
      ${byCat}
    </div>
  `.trim();
}

// Count findings by severity across every category. Used to populate the
// stat cards and nav badges in the template. Zero-fills every level so the
// template's JS always has numeric values to render.
function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, passing: 0 };
  const cats = findings.categories || [];
  for (const cat of cats) {
    for (const f of cat.findings || []) {
      const sev = (f.severity || 'medium').toLowerCase();
      if (counts[sev] !== undefined) counts[sev] += 1;
    }
  }
  // If the findings JSON already carries pre-computed counts, prefer them
  // so callers can override (e.g., when including audit-permissions findings
  // that were bucketed upstream).
  const bs = findings.summary?.bySeverity;
  if (bs && typeof bs === 'object') {
    for (const k of ['critical', 'high', 'medium', 'passing']) {
      if (typeof bs[k] === 'number') counts[k] = bs[k];
    }
  }
  return counts;
}

function renderFinding(f) {
  const rem = f.remediation || {};
  const sev = (f.severity || 'medium').toLowerCase();
  const sevLabel = sev[0].toUpperCase() + sev.slice(1);
  const status = (rem.appliedStatus || 'open').toLowerCase();
  const statusLabel = status[0].toUpperCase() + status.slice(1);
  const beforeAfter = (rem.beforeValue != null || rem.afterValue != null)
    ? `
      <div class="before-after">
        <div>
          <div class="label">Before</div>
          <code>${escapeHtml(JSON.stringify(rem.beforeValue ?? null))}</code>
        </div>
        <div>
          <div class="label">After</div>
          <code>${escapeHtml(JSON.stringify(rem.afterValue ?? null))}</code>
        </div>
      </div>`
    : '';
  const delegatePill = rem.delegateTo
    ? ` <code>${escapeHtml(rem.delegateTo)}</code>`
    : '';
  return `
    <div class="finding-card filter-${escapeHtml(sev)}">
      <div class="finding-header">
        <span class="severity severity-${escapeHtml(sev)}">${escapeHtml(sevLabel)}</span>
        <span class="finding-title">${escapeHtml(f.title || '(untitled finding)')}</span>
        ${f.source ? `<span class="finding-source">${escapeHtml(f.source)}</span>` : ''}
        <span class="finding-status finding-status-${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        <span class="finding-chevron">&#9654;</span>
      </div>
      <div class="finding-body">
        ${f.evidence ? `<div style="margin-top:10px;"><div class="field-label">Evidence</div><div class="evidence-block">${escapeHtml(f.evidence)}</div></div>` : ''}
        ${rem.description ? `<div style="margin-top:10px;"><div class="field-label">Suggested remediation</div><div class="remediation-block"><strong>Fix:</strong> ${escapeHtml(rem.description)}${delegatePill ? ` (via${delegatePill})` : ''}</div></div>` : ''}
        ${beforeAfter}
      </div>
    </div>
  `.trim();
}

function renderCategories(findings) {
  const cats = findings.categories || [];
  if (cats.length === 0) return '<div class="empty-state">No findings recorded.</div>';
  return cats.map((cat) => {
    const items = (cat.findings || []);
    return `
    <div class="category-block">
      <div class="category-head">
        <h3>${escapeHtml(cat.name || cat.id || '(unnamed)')}</h3>
        <span class="category-count">${escapeHtml(items.length)} finding${items.length === 1 ? '' : 's'}</span>
      </div>
      ${items.length === 0 ? '<div class="empty-state" style="padding:20px;">No findings in this category.</div>' : items.map(renderFinding).join('\n')}
    </div>
  `.trim();
  }).join('\n');
}

// Detect whether the review is running under the OWASP Top 10 framework.
// When true, audit-permissions findings fold into A01 upstream and this
// function returns an empty-state card (the standalone Table Permissions
// tab is superseded by the inline A01 rendering). For every other
// framework (CWE, ASVS, SCA, license, bring-your-own) the standalone
// section renders because audit-permissions findings do not map cleanly
// into those frameworks' categories.
function isOwaspFramework(findings) {
  const fw = findings.metadata?.framework;
  if (!fw || typeof fw !== 'string') return false;
  return /owasp\s*top\s*10/i.test(fw);
}

function renderPermissionsAudit(findings) {
  const pa = findings.permissionsAudit;
  if (!pa) {
    return '<div class="empty-state">The table-permissions audit was not included in this review.</div>';
  }
  // OWASP Top 10: the meta-skill merges pa.findings[] into categories[id=A01]
  // upstream, so the standalone Table Permissions section is redundant.
  // Point the reader at A01 and the full-evidence deep-link.
  if (isOwaspFramework(findings)) {
    const reportPath = pa.reportPath || 'docs/permissions-audit.html';
    return `
      <div class="permissions-link">
        Table-permission findings are folded into <strong>A01 Broken Access Control</strong> on the Findings tab
        so they render inline with every other A01 finding under the unified severity scheme.
        Full evidence and the original severity-grouped report remain at
        <a href="${escapeHtml(reportPath)}"><code>${escapeHtml(reportPath)}</code></a>;
        fixes still route to the <code>table-permissions-architect</code> agent via <code>/audit-permissions</code>.
      </div>
    `.trim();
  }
  const s = pa.summary || {};
  const reportPath = pa.reportPath || 'docs/permissions-audit.html';
  // Map audit-permissions' severity scheme (critical/warning/info/pass) to
  // the security skill's unified scheme (critical/high/medium/passing). The
  // mapping matches the one documented in references/orchestration.md
  // (§Severity scheme) — audit-permissions findings are preserved verbatim
  // under the unified labels so users see one scheme across the report.
  const critical = s.critical ?? 0;
  const high = s.warning ?? 0;
  const medium = s.info ?? 0;
  const passing = s.pass ?? 0;
  return `
    <div class="permissions-link">
      Full evidence: <a href="${escapeHtml(reportPath)}"><code>${escapeHtml(reportPath)}</code></a>.
      Audit-permissions findings do not map cleanly into this framework's categories,
      so they render here under the unified Critical / High / Medium / Passing scheme;
      fixes still route to the <code>table-permissions-architect</code> agent via <code>/audit-permissions</code>.
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num" style="color:var(--critical)">${escapeHtml(critical)}</div><div class="stat-label">Critical</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--high)">${escapeHtml(high)}</div><div class="stat-label">High</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--medium)">${escapeHtml(medium)}</div><div class="stat-label">Medium</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--passing)">${escapeHtml(passing)}</div><div class="stat-label">Passing</div></div>
    </div>
    ${pa.note ? `<div class="card" style="font-size:13px;color:var(--text-dim);margin-top:10px;">${escapeHtml(pa.note)}</div>` : ''}
  `.trim();
}

function renderPendingScans(findings) {
  const pending = findings.metadata?.pendingScans;
  if (!pending || pending.length === 0) {
    return '<div class="empty-state">No long-running scans are pending.</div>';
  }
  const items = pending
    .map((p) => `<li><strong>${escapeHtml(p.type || 'unknown scan')}</strong> — poll with <code>${escapeHtml(p.pollCommand || '(no command)')}</code></li>`)
    .join('\n');
  return `
    <div class="pending-banner">
      <h4>Additional findings pending</h4>
      <ul>${items}</ul>
    </div>
  `.trim();
}

function renderMetadata(findings) {
  const m = findings.metadata || {};
  const scans = Array.isArray(m.scansIncluded) && m.scansIncluded.length
    ? m.scansIncluded.join(', ')
    : '(none)';
  const skipped = Array.isArray(m.scansSkipped) && m.scansSkipped.length
    ? m.scansSkipped.join(', ')
    : '(none)';
  return `
    <dl class="metadata-dl">
      <dt>Framework</dt><dd>${escapeHtml(m.framework || '(not recorded)')}</dd>
      <dt>Site</dt><dd>${escapeHtml(m.siteName || '(unknown)')}</dd>
      <dt>Portal id</dt><dd><code>${escapeHtml(m.portalId || '(unknown)')}</code></dd>
      <dt>Generated</dt><dd>${escapeHtml(m.generatedAt || new Date().toISOString())}</dd>
      <dt>Scans run</dt><dd>${escapeHtml(scans)}</dd>
      <dt>Scans skipped</dt><dd>${escapeHtml(skipped)}</dd>
    </dl>
  `.trim();
}

function siteNameFromFindings(findings) {
  return findings.metadata?.siteName || 'Power Pages site';
}

function render({ findingsPath, outputPath, dryRun = false } = {}) {
  if (!findingsPath || typeof findingsPath !== 'string') {
    throw invalidArgs('--findings is required');
  }
  if (!outputPath || typeof outputPath !== 'string') {
    throw invalidArgs('--output is required');
  }
  if (!fs.existsSync(findingsPath)) {
    throw invalidArgs(`findings file not found: ${findingsPath}`);
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    const err = new Error(`template not found at ${TEMPLATE_PATH}`);
    err.code = 'UNKNOWN';
    throw err;
  }

  let findings;
  try {
    findings = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
  } catch (err) {
    throw invalidArgs(`findings file is not valid JSON: ${err.message}`);
  }
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const severityCounts = countBySeverity(findings);
  const pendingCount = Array.isArray(findings.metadata?.pendingScans)
    ? findings.metadata.pendingScans.length
    : 0;
  const tokens = {
    __SITE_NAME__: escapeHtml(siteNameFromFindings(findings)),
    __METADATA__: renderMetadata(findings),
    __SUMMARY__: renderSummary(findings),
    __PENDING_SCANS__: renderPendingScans(findings),
    __CATEGORIES__: renderCategories(findings),
    __PERMISSIONS_AUDIT__: renderPermissionsAudit(findings),
    // Severity counts and pending count are injected as JSON literals so the
    // template's small amount of JS can render stat cards and nav badges
    // without an extra data-attribute round-trip.
    __SEVERITY_COUNTS_JSON__: JSON.stringify(severityCounts),
    __PENDING_COUNT__: String(pendingCount),
  };

  let html = template;
  for (const [token, value] of Object.entries(tokens)) {
    html = html.split(token).join(value);
  }

  const bytes = Buffer.byteLength(html, 'utf8');

  if (dryRun) {
    // Destructive-writes rule (§5.7): dry-run validates inputs and reports
    // what WOULD be written without touching the filesystem.
    return { dryRun: true, wouldWrite: outputPath, bytes, severityCounts };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');

  return { outputPath, bytes };
}

function parseCli(argv) {
  const options = {
    findings: { type: 'string' },
    output: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function main() {
  let args;
  try {
    args = parseCli(process.argv);
  } catch (err) {
    exitWithMessage(EXIT.INVALID_ARGS, `Argument error: ${err.message}\n\n${HELP}`);
    return;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  try {
    const result = render({
      findingsPath: args.findings,
      outputPath: args.output,
      dryRun: Boolean(args['dry-run']),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode = err.code === 'INVALID_ARGS' ? EXIT.INVALID_ARGS : EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  render,
  escapeHtml,
  renderSummary,
  renderCategories,
  renderFinding,
  renderPermissionsAudit,
  renderPendingScans,
  renderMetadata,
  countBySeverity,
  siteNameFromFindings,
  isOwaspFramework,
  TEMPLATE_PATH,
  EXIT,
};
