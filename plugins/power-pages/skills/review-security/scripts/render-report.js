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

// Return the concern-section array. The canonical shape is
// `findings.concerns[]` — one entry per concern the user picked in Phase 2.
// For backward compatibility, a flat `findings.categories[]` is accepted
// and wrapped in a single unnamed concern so older callers keep working.
function getConcerns(findings) {
  if (Array.isArray(findings.concerns) && findings.concerns.length > 0) {
    return findings.concerns;
  }
  if (Array.isArray(findings.categories) && findings.categories.length > 0) {
    return [{ name: findings.metadata?.framework || '', categories: findings.categories }];
  }
  return [];
}

function renderSummary(findings) {
  const s = findings.summary || {};
  const total = s.totalFindings ?? 0;
  // Per-concern subtotals are the primary summary axis now. Fall back to
  // the older `byCategory` shape when the JSON was produced against the
  // pre-multi-concern schema.
  const byConcern = s.byConcern && typeof s.byConcern === 'object' ? s.byConcern : null;
  let subtotalsHtml = '';
  if (byConcern && Object.keys(byConcern).length > 0) {
    const rows = Object.entries(byConcern)
      .map(([concernName, counts]) => {
        const c = counts || {};
        const total = (c.critical || 0) + (c.high || 0) + (c.medium || 0) + (c.passing || 0);
        return `<li style="display:inline-block;padding:4px 10px;margin:2px 4px 2px 0;background:var(--surface2);border:1px solid var(--border);border-radius:12px;font-size:12px;"><strong style="font-family:var(--mono);color:var(--text-bright);">${escapeHtml(total)}</strong> <span style="color:var(--text-dim);">${escapeHtml(concernName)}</span></li>`;
      })
      .join('');
    subtotalsHtml = `<div style="margin-top:10px;"><div class="field-label">By concern</div><ul style="list-style:none;padding:0;margin:6px 0 0;">${rows}</ul></div>`;
  } else {
    const bc = s.byCategory || {};
    if (Object.keys(bc).length > 0) {
      const rows = Object.entries(bc)
        .map(([cat, count]) => `<li style="display:inline-block;padding:4px 10px;margin:2px 4px 2px 0;background:var(--surface2);border:1px solid var(--border);border-radius:12px;font-size:12px;"><strong style="font-family:var(--mono);color:var(--text-bright);">${escapeHtml(count)}</strong> <span style="color:var(--text-dim);">${escapeHtml(cat)}</span></li>`)
        .join('');
      subtotalsHtml = `<div style="margin-top:10px;"><div class="field-label">By category</div><ul style="list-style:none;padding:0;margin:6px 0 0;">${rows}</ul></div>`;
    }
  }
  return `
    <div style="font-size:13px;line-height:1.75;">
      <div>Total findings: <strong style="color:var(--text-bright);">${escapeHtml(total)}</strong></div>
      ${subtotalsHtml}
    </div>
  `.trim();
}

// Count findings by severity across every concern's categories. Used to
// populate the stat cards and nav badges in the template. Zero-fills
// every level so the template's JS always has numeric values to render.
function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, passing: 0 };
  for (const concern of getConcerns(findings)) {
    for (const cat of concern.categories || []) {
      for (const f of cat.findings || []) {
        const sev = (f.severity || 'medium').toLowerCase();
        if (counts[sev] !== undefined) counts[sev] += 1;
      }
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

// Render the optional cveEnrichment line for findings that carry one. Each
// sub-object (cvss / epss / kev) is independent — if a runtime fetch errored
// or hit a 429, only the sub-objects that succeeded are present, and the
// rendered line skips the missing pieces gracefully.
function renderCveEnrichment(enrichment) {
  if (!enrichment || typeof enrichment !== 'object') return '';
  const parts = [];
  const cvss = enrichment.cvss;
  if (cvss && (cvss.baseScore != null || cvss.baseSeverity)) {
    const score = cvss.baseScore != null ? `CVSS ${escapeHtml(cvss.baseScore)}` : 'CVSS';
    const sev = cvss.baseSeverity ? ` ${escapeHtml(cvss.baseSeverity)}` : '';
    parts.push(`${score}${sev}`);
  }
  const epss = enrichment.epss;
  if (epss && epss.epss != null) {
    const pct = epss.percentile != null
      ? ` (top ${escapeHtml(Math.round((1 - Number(epss.percentile)) * 100))}%)`
      : '';
    parts.push(`EPSS ${escapeHtml(epss.epss)}${pct}`);
  }
  const kev = enrichment.kev;
  if (kev && typeof kev === 'object') {
    if (kev.listed) {
      const due = kev.dueDate ? `, due ${escapeHtml(kev.dueDate)}` : '';
      const added = kev.dateAdded ? ` (added ${escapeHtml(kev.dateAdded)}${due})` : '';
      parts.push(`KEV: yes${added}`);
    } else {
      parts.push('KEV: no');
    }
  }
  if (parts.length === 0) return '';
  const cveId = enrichment.cveId ? `<strong>${escapeHtml(enrichment.cveId)}</strong> · ` : '';
  return `<div style="margin-top:10px;"><div class="field-label">Live metrics</div><div class="cve-enrichment">${cveId}${parts.join(' · ')}</div></div>`;
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
  const cveBlock = renderCveEnrichment(f.cveEnrichment);
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
        ${cveBlock}
        ${rem.description ? `<div style="margin-top:10px;"><div class="field-label">Suggested remediation</div><div class="remediation-block"><strong>Fix:</strong> ${escapeHtml(rem.description)}${delegatePill ? ` (via${delegatePill})` : ''}</div></div>` : ''}
        ${beforeAfter}
      </div>
    </div>
  `.trim();
}

// Render one category block (used inside a concern section). Pure markup
// — the concern-level wrapper is in renderConcerns.
function renderCategoryBlock(cat) {
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
}

function renderConcerns(findings) {
  const concerns = getConcerns(findings);
  if (concerns.length === 0) return '<div class="empty-state">No findings recorded.</div>';
  // When exactly one concern is selected, render its categories inline
  // without an extra accordion level — a single-concern report reads more
  // cleanly as a flat list of categories than as a one-entry accordion.
  if (concerns.length === 1) {
    const only = concerns[0];
    const cats = only.categories || [];
    if (cats.length === 0) return '<div class="empty-state">No findings recorded.</div>';
    return cats.map(renderCategoryBlock).join('\n');
  }
  return concerns.map((concern) => {
    const cats = concern.categories || [];
    const findingCount = cats.reduce((sum, c) => sum + (c.findings?.length || 0), 0);
    const body = cats.length === 0
      ? '<div class="empty-state" style="padding:20px;">No findings in this concern.</div>'
      : cats.map(renderCategoryBlock).join('\n');
    return `
    <div class="concern-block">
      <div class="concern-head">
        <h2 class="concern-title">${escapeHtml(concern.name || '(unnamed concern)')}</h2>
        <span class="concern-count">${escapeHtml(findingCount)} finding${findingCount === 1 ? '' : 's'}</span>
      </div>
      <div class="concern-body">
        ${body}
      </div>
    </div>
  `.trim();
  }).join('\n');
}

// Detect whether "OWASP Top 10" is among the selected concerns. When
// true, audit-permissions findings are expected to have been folded into
// the OWASP concern's A01 category upstream and the standalone Table
// Permissions section collapses to a deep-link. When OWASP Top 10 is not
// in the concern list, the standalone section renders with the 4-stat
// grid because permission findings do not map cleanly into other
// concerns' groupings.
function hasOwaspConcern(findings) {
  const concerns = findings.metadata?.concerns;
  if (Array.isArray(concerns)) {
    return concerns.some((c) => typeof c === 'string' && /owasp\s*top\s*10/i.test(c));
  }
  // Backward-compat: older JSON uses `metadata.framework` (single string).
  const fw = findings.metadata?.framework;
  if (typeof fw === 'string') return /owasp\s*top\s*10/i.test(fw);
  return false;
}

function renderPermissionsAudit(findings) {
  const pa = findings.permissionsAudit;
  if (!pa) {
    return '<div class="empty-state">The table-permissions audit was not included in this review.</div>';
  }
  // When "OWASP Top 10" is among the selected concerns, the meta-skill
  // has already merged pa.findings[] into that concern's A01 category,
  // so the standalone Table Permissions section collapses to a link.
  if (hasOwaspConcern(findings)) {
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
      Audit-permissions findings do not map cleanly into the selected concerns' groupings,
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

// Domain banner — shows the chosen industry profile, regulatory frame, and
// the headline emphasis snippet (failure_emphasis or pass_emphasis from the
// domain profile). Returns empty string when no domain was set.
function renderDomainBanner(findings) {
  const m = findings.metadata || {};
  const domain = m.domain;
  if (!domain || (!domain.key && !domain.displayName)) return '';
  const display = escapeHtml(domain.displayName || domain.key);
  const key = domain.key ? ` <code>${escapeHtml(domain.key)}</code>` : '';
  const frame = m.regulatoryFrame
    ? `<div style="margin-top:6px;font-size:12px;color:var(--text-dim);"><strong>Regulatory frame:</strong> ${escapeHtml(m.regulatoryFrame)}</div>`
    : '';
  const headline = m.headline && m.headline.text
    ? `<div class="domain-headline domain-headline-${escapeHtml((m.headline.kind || 'failure').toLowerCase())}">${escapeHtml(m.headline.text)}</div>`
    : '';
  return `
    <div class="domain-banner">
      <div class="domain-banner-head"><strong>Domain:</strong> ${display}${key}</div>
      ${frame}
      ${headline}
    </div>
  `.trim();
}

// Confidence messages — one card per scan family that produced zero findings.
// The skill picks the matching CM-* template from threat-context.md and
// passes the title + body in the JSON; this just renders.
function renderConfidenceMessages(findings) {
  const list = findings.metadata?.confidenceMessages;
  if (!Array.isArray(list) || list.length === 0) return '';
  const items = list.map((m) => {
    const id = m && m.id ? `<span class="confidence-id">${escapeHtml(m.id)}</span>` : '';
    const title = m && m.title ? `<strong>${escapeHtml(m.title)}</strong>` : '';
    const text = m && m.text ? `<div class="confidence-text">${escapeHtml(m.text)}</div>` : '';
    return `<div class="confidence-card">${id}${title}${text}</div>`;
  }).join('\n');
  return `
    <div class="confidence-list">
      <h3>Clean clusters</h3>
      ${items}
    </div>
  `.trim();
}

// Regulatory coverage — one card per standard from the domain profile's
// regulatory_frame. Each card has a row per control with a status pill
// (covered / not-applicable / manual-only) and deep-links to evidence
// findings. When the regulatoryCoverage array is empty (e.g., `general`
// domain), shows the empty-state message.
function renderRegulatoryCoverage(findings) {
  const list = findings.metadata?.regulatoryCoverage;
  if (!Array.isArray(list) || list.length === 0) {
    return '<div class="empty-state">No regulatory framework was selected for this review.</div>';
  }
  // Group by standard, preserving first-seen order.
  const order = [];
  const grouped = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const standard = row.standard || '(unspecified standard)';
    if (!grouped.has(standard)) {
      grouped.set(standard, []);
      order.push(standard);
    }
    grouped.get(standard).push(row);
  }
  return order.map((standard) => {
    const rows = grouped.get(standard);
    const counts = { covered: 0, 'not-applicable': 0, 'manual-only': 0 };
    for (const r of rows) {
      const s = (r.status || 'manual-only').toLowerCase();
      if (counts[s] !== undefined) counts[s] += 1;
    }
    const summary = `${counts.covered} covered · ${counts['not-applicable']} not run · ${counts['manual-only']} manual-only`;
    const tableRows = rows.map((r) => {
      const status = (r.status || 'manual-only').toLowerCase();
      const STATUS_LABELS = {
        'covered': 'Covered',
        'not-applicable': 'Not run',
        'manual-only': 'Manual only',
      };
      const statusLabel = STATUS_LABELS[status] || status;
      const refs = Array.isArray(r.findingsRefs) && r.findingsRefs.length
        ? `<div class="control-refs">${r.findingsRefs.length} finding${r.findingsRefs.length === 1 ? '' : 's'}: ${r.findingsRefs.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}</div>`
        : '';
      const source = r.checkSource
        ? `<div class="control-source"><span class="field-label">Check source</span> ${escapeHtml(r.checkSource)}</div>`
        : '';
      return `
        <tr class="control-row control-row-${escapeHtml(status)}">
          <td class="control-id"><code>${escapeHtml(r.controlId || '')}</code></td>
          <td class="control-name">${escapeHtml(r.controlName || '')}${source}${refs}</td>
          <td class="control-status"><span class="control-pill control-pill-${escapeHtml(status)}">${escapeHtml(statusLabel)}</span></td>
        </tr>
      `.trim();
    }).join('\n');
    return `
      <div class="standard-card">
        <div class="standard-head">
          <h3>${escapeHtml(standard)}</h3>
          <span class="standard-summary">${escapeHtml(summary)}</span>
        </div>
        <table class="control-table">
          <thead><tr><th>Control</th><th>Title</th><th>Status</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `.trim();
  }).join('\n');
}

// Tradeoffs to disclose — at least one caveat from threat-context.md. Always
// rendered when the skill includes tradeoffs in metadata; the SKILL.md
// requires at least one. Empty array → empty render so callers that omit it
// don't crash, but they should always include one.
function renderTradeoffs(findings) {
  const list = findings.metadata?.tradeoffs;
  if (!Array.isArray(list) || list.length === 0) {
    return '<div class="empty-state" style="padding:20px;">No tradeoffs disclosed.</div>';
  }
  const items = list.map((t) => `<li>${escapeHtml(t)}</li>`).join('\n');
  return `
    <div class="tradeoffs-card">
      <h3 style="margin-top:0;">Tradeoffs to keep in mind</h3>
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
  // Prefer the multi-concern `concerns[]` list; fall back to the legacy
  // single-string `framework` field so older JSON still renders usable
  // metadata.
  let concernsLabel;
  if (Array.isArray(m.concerns) && m.concerns.length > 0) {
    concernsLabel = m.concerns.join(', ');
  } else if (typeof m.framework === 'string' && m.framework.length > 0) {
    concernsLabel = m.framework;
  } else {
    concernsLabel = '(not recorded)';
  }
  // `deepScan` is a boolean Phase 2 sets when the user opts into the ZAP
  // deep dynamic scan. Surface it so the report explicitly shows the
  // thoroughness knob the user chose — "included" vs "skipped" is more
  // scannable than reading it off the scansIncluded list.
  const deepScanLabel = m.deepScan === true
    ? 'Included'
    : m.deepScan === false
    ? 'Skipped'
    : '(not recorded)';
  // Domain row — surface the industry classification and regulatory frame
  // in the metadata table when set. Falls back gracefully when neither is
  // recorded (older JSON or the user picked `general` without a frame).
  const domainLabel = (() => {
    const d = m.domain;
    if (!d) return '(not recorded)';
    if (d.displayName && d.key) return `${d.displayName} (${d.key})`;
    return d.displayName || d.key || '(not recorded)';
  })();
  const frameLabel = m.regulatoryFrame ? escapeHtml(m.regulatoryFrame) : '(none specified)';
  return `
    <dl class="metadata-dl">
      <dt>Concerns</dt><dd>${escapeHtml(concernsLabel)}</dd>
      <dt>Domain</dt><dd>${escapeHtml(domainLabel)}</dd>
      <dt>Regulatory frame</dt><dd>${frameLabel}</dd>
      <dt>Deep dynamic scan</dt><dd>${escapeHtml(deepScanLabel)}</dd>
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
    __DOMAIN_BANNER__: renderDomainBanner(findings),
    __METADATA__: renderMetadata(findings),
    __SUMMARY__: renderSummary(findings),
    __CONFIDENCE_MESSAGES__: renderConfidenceMessages(findings),
    __PENDING_SCANS__: renderPendingScans(findings),
    __CATEGORIES__: renderConcerns(findings),
    __PERMISSIONS_AUDIT__: renderPermissionsAudit(findings),
    __REGULATORY_COVERAGE__: renderRegulatoryCoverage(findings),
    __TRADEOFFS__: renderTradeoffs(findings),
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
  renderConcerns,
  renderCategoryBlock,
  renderFinding,
  renderCveEnrichment,
  renderPermissionsAudit,
  renderPendingScans,
  renderMetadata,
  renderDomainBanner,
  renderConfidenceMessages,
  renderRegulatoryCoverage,
  renderTradeoffs,
  countBySeverity,
  siteNameFromFindings,
  hasOwaspConcern,
  getConcerns,
  TEMPLATE_PATH,
  EXIT,
};
