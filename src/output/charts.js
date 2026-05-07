// SVG chart helpers. Pure-string SVG output for the charts themselves; the
// svgToPng helper rasterises via `sharp` for embedding into Confluence (which
// strips inline SVG but accepts PNG attachments).
//
// renderTrendCharts() takes a PD history array (oldest→newest) and produces
// three named chart files: total alerts, MTTA (H+L), MTTR (H+L).

import sharp from 'sharp';
import { SLO_MS } from '../sources/pagerduty.js';

// Rasterise an SVG string to a PNG Buffer. density=144 → 2× the SVG's
// intrinsic size, which keeps text crisp on Retina without bloating files.
export async function svgToPng(svg, { density = 144 } = {}) {
  return sharp(Buffer.from(svg), { density }).png().toBuffer();
}

const PLOT = {
  width: 640,
  height: 220,
  margin: { top: 50, right: 20, bottom: 36, left: 60 }
};

function plotArea() {
  const { width, height, margin } = PLOT;
  return {
    x0: margin.left,
    y0: margin.top,
    w: width - margin.left - margin.right,
    h: height - margin.top - margin.bottom
  };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgWrap(content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT.width} ${PLOT.height}" width="${PLOT.width}" height="${PLOT.height}" font-family="-apple-system, sans-serif">
${content}
</svg>`;
}

function shortLabel(label) {
  // "2026-04" -> "Apr"
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = parseInt(label.split('-')[1], 10) - 1;
  return MONTHS[m] || label;
}

function fmtHours(ms) {
  if (ms == null) return '';
  const h = ms / (60 * 60 * 1000);
  if (h >= 24) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  const min = Math.round(h * 60);
  return `${min}m`;
}

// Stacked bar chart. `series` is an array of { name, color, points: number[] };
// each month sums the series values into a single bar, segments stacked
// bottom→top in array order. Total label sits on top of the bar.
export function barChart({ series, labels, title }) {
  const seriesArray = series || [];
  const totals = labels.map((_, i) =>
    seriesArray.reduce((sum, s) => sum + (s.points[i] ?? 0), 0)
  );
  const yMax = niceCeil(Math.max(...totals, 1));

  const { x0, y0, w, h } = plotArea();
  const slotW = w / labels.length;
  const barW = slotW * 0.65;

  const parts = [];
  if (title) parts.push(`<text x="${PLOT.width / 2}" y="18" font-size="13" fill="#172b4d" text-anchor="middle" font-weight="600">${esc(title)}</text>`);

  // Y-axis baseline + mid gridline + ticks
  parts.push(`<line x1="${x0}" y1="${y0 + h}" x2="${x0 + w}" y2="${y0 + h}" stroke="#172b4d" stroke-width="1"/>`);
  parts.push(`<line x1="${x0}" y1="${y0 + h / 2}" x2="${x0 + w}" y2="${y0 + h / 2}" stroke="#ebecf0"/>`);
  parts.push(`<text x="${x0 - 6}" y="${y0 + h + 4}" font-size="11" fill="#5e6c84" text-anchor="end">0</text>`);
  parts.push(`<text x="${x0 - 6}" y="${y0 + h / 2 + 4}" font-size="11" fill="#5e6c84" text-anchor="end">${yMax / 2}</text>`);
  parts.push(`<text x="${x0 - 6}" y="${y0 + 4}" font-size="11" fill="#5e6c84" text-anchor="end">${yMax}</text>`);

  for (let i = 0; i < labels.length; i++) {
    const x = x0 + slotW * i + (slotW - barW) / 2;
    let yCursor = y0 + h; // bottom of bar
    for (const s of seriesArray) {
      const v = s.points[i] ?? 0;
      if (v <= 0) continue;
      const segH = (v / yMax) * h;
      yCursor -= segH;
      parts.push(`<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${s.color}"/>`);
    }
    // Total above the bar
    const total = totals[i];
    const totalY = y0 + h - (total / yMax) * h;
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${(totalY - 4).toFixed(1)}" font-size="11" fill="#172b4d" text-anchor="middle">${total}</text>`);
    // Month label
    parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${y0 + h + 18}" font-size="11" fill="#5e6c84" text-anchor="middle">${esc(labels[i])}</text>`);
  }

  // Legend top-right; render in reverse so the visually-on-top series shows
  // first. Only emit a legend when there's >1 series (single-series doesn't
  // need a label — the chart title carries the metric name).
  if (seriesArray.length > 1) {
    const legend = [...seriesArray].reverse();
    for (let i = 0; i < legend.length; i++) {
      const s = legend[i];
      const lx = PLOT.width - PLOT.margin.right - 100;
      const ly = 16 + i * 14;
      parts.push(`<circle cx="${lx}" cy="${ly - 4}" r="3" fill="${s.color}"/>`);
      parts.push(`<text x="${lx + 8}" y="${ly}" font-size="11" fill="#172b4d">${esc(s.name)}</text>`);
    }
  }

  return svgWrap(parts.join('\n  '));
}

export function lineChart({ series, labels, title, sloLines = [], yLabel = String }) {
  // Determine yMax from data + SLO lines (give SLO a bit of headroom).
  const dataPoints = series.flatMap(s => s.points.filter(p => p != null));
  const sloVals = sloLines.map(s => s.value);
  const rawMax = Math.max(...dataPoints, ...sloVals, 1);
  const yMax = niceCeil(rawMax);

  const { x0, y0, w, h } = plotArea();
  const slotW = w / labels.length;
  const xAt = i => x0 + slotW * (i + 0.5);
  const yAt = v => y0 + h - (v / yMax) * h;

  const parts = [];
  if (title) parts.push(`<text x="${PLOT.width / 2}" y="18" font-size="13" fill="#172b4d" text-anchor="middle" font-weight="600">${esc(title)}</text>`);

  // Y-axis baseline + mid gridline + ticks
  parts.push(`<line x1="${x0}" y1="${y0 + h}" x2="${x0 + w}" y2="${y0 + h}" stroke="#172b4d" stroke-width="1"/>`);
  parts.push(`<line x1="${x0}" y1="${y0 + h / 2}" x2="${x0 + w}" y2="${y0 + h / 2}" stroke="#ebecf0"/>`);
  parts.push(`<text x="${x0 - 6}" y="${y0 + h + 4}" font-size="11" fill="#5e6c84" text-anchor="end">0</text>`);
  parts.push(`<text x="${x0 - 6}" y="${y0 + h / 2 + 4}" font-size="11" fill="#5e6c84" text-anchor="end">${esc(yLabel(yMax / 2))}</text>`);
  parts.push(`<text x="${x0 - 6}" y="${y0 + 4}" font-size="11" fill="#5e6c84" text-anchor="end">${esc(yLabel(yMax))}</text>`);

  // SLO threshold lines (no inline label — they overlap when both fall near
  // the bottom of a tall y-axis; see legend below the title for the key).
  for (const slo of sloLines) {
    const y = yAt(slo.value);
    if (y < y0 || y > y0 + h) continue;
    parts.push(`<line x1="${x0}" y1="${y.toFixed(1)}" x2="${x0 + w}" y2="${y.toFixed(1)}" stroke="${slo.color}" stroke-width="1" stroke-dasharray="4 3"/>`);
  }

  // Series: break into runs of consecutive non-null points; draw polyline + dots
  for (const s of series) {
    const runs = [];
    let cur = [];
    for (let i = 0; i < s.points.length; i++) {
      const v = s.points[i];
      if (v == null) {
        if (cur.length) { runs.push(cur); cur = []; }
      } else {
        cur.push({ x: xAt(i), y: yAt(v), v });
      }
    }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      if (run.length > 1) {
        const pts = run.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        parts.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"/>`);
      }
      for (const p of run) {
        parts.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${s.color}"/>`);
      }
    }
  }

  // X-axis labels
  for (let i = 0; i < labels.length; i++) {
    parts.push(`<text x="${xAt(i).toFixed(1)}" y="${y0 + h + 18}" font-size="11" fill="#5e6c84" text-anchor="middle">${esc(labels[i])}</text>`);
  }

  // Combined legend just below the title — series first (solid dot), then
  // SLO thresholds (dashed segment). Horizontal so we don't crowd the chart.
  const legendY = 36;
  let lx = x0;
  for (const s of series) {
    parts.push(`<circle cx="${(lx + 4).toFixed(1)}" cy="${legendY - 4}" r="3.5" fill="${s.color}"/>`);
    parts.push(`<text x="${lx + 13}" y="${legendY}" font-size="11" fill="#172b4d">${esc(s.name)}</text>`);
    lx += 13 + s.name.length * 6.5 + 14;
  }
  for (const slo of sloLines) {
    parts.push(`<line x1="${lx.toFixed(1)}" y1="${legendY - 4}" x2="${(lx + 10).toFixed(1)}" y2="${legendY - 4}" stroke="${slo.color}" stroke-width="1.5" stroke-dasharray="3 2"/>`);
    parts.push(`<text x="${lx + 14}" y="${legendY}" font-size="11" fill="#172b4d">${esc(slo.label)}</text>`);
    lx += 14 + slo.label.length * 6.5 + 14;
  }

  return svgWrap(parts.join('\n  '));
}

// Round up to a friendlier number (10, 50, 100, 200, 500, 1000, ...) so the
// y-axis ticks aren't ugly fractions.
function niceCeil(n) {
  if (n <= 1) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

export function renderTrendCharts({ pd = null, rollbar = null, jira = null, github = null }, team) {
  const charts = [];

  if (pd) {
    const labels = pd.map(m => shortLabel(m.label));
    const highs = pd.map(m => m.high ?? 0);
    const lows = pd.map(m => m.low ?? 0);
    const mttaHigh = pd.map(m => m.mttaHighMs);
    const mttaLow = pd.map(m => m.mttaLowMs);
    const mttrHigh = pd.map(m => m.mttrHighMs);
    const mttrLow = pd.map(m => m.mttrLowMs);

    charts.push(
    {
      name: 'pd-alerts',
      svg: barChart({
        series: [
          { name: 'Low Urgency', color: '#0052cc', points: lows },
          { name: 'High Urgency', color: '#d04437', points: highs }
        ],
        labels,
        title: `${team.displayName} — PD Alerts (production)`
      })
    },
    {
      name: 'pd-mtta',
      svg: lineChart({
        series: [
          { name: 'High Urgency', color: '#d04437', points: mttaHigh },
          { name: 'Low Urgency', color: '#0052cc', points: mttaLow }
        ],
        labels,
        title: `${team.displayName} — MTTA`,
        yLabel: fmtHours,
        sloLines: [
          { value: SLO_MS.mtta.high, color: '#d04437', label: '1h SLO' },
          { value: SLO_MS.mtta.low, color: '#0052cc', label: '9h SLO' }
        ]
      })
    },
    {
      name: 'pd-mttr',
      svg: lineChart({
        series: [
          { name: 'High Urgency', color: '#d04437', points: mttrHigh },
          { name: 'Low Urgency', color: '#0052cc', points: mttrLow }
        ],
        labels,
        title: `${team.displayName} — MTTR`,
        yLabel: fmtHours,
        sloLines: [
          { value: SLO_MS.mttr.high, color: '#d04437', label: '4h SLO' },
          { value: SLO_MS.mttr.low, color: '#0052cc', label: '15h SLO' }
        ]
      })
    });
  }

  if (rollbar) {
    const labels = rollbar.map(m => shortLabel(m.label));
    const open = rollbar.map(m => m.open ?? 0);
    charts.push({
      name: 'rollbar-errors',
      svg: barChart({
        series: [{ name: 'Open', color: '#0052cc', points: open }],
        labels,
        title: `${team.displayName} — Open Rollbar errors at end of month`
      })
    });
  }

  if (jira) {
    const labels = jira.map(m => shortLabel(m.label));
    const incidents = jira.map(m => m.incidents ?? 0);
    const bugs = jira.map(m => m.bugs ?? 0);
    charts.push({
      name: 'jira-incidents',
      svg: barChart({
        series: [{ name: 'Open', color: '#d04437', points: incidents }],
        labels,
        title: `${team.displayName} — Open Jira Incidents at end of month`
      })
    });
    charts.push({
      name: 'jira-bugs',
      svg: barChart({
        series: [{ name: 'Open', color: '#ff8b00', points: bugs }],
        labels,
        title: `${team.displayName} — Open Jira Bugs at end of month`
      })
    });
  }

  if (github) {
    const labels = github.map(m => shortLabel(m.label));
    const vulns = github.map(m => m.vulnerabilities ?? 0);
    const prs = github.map(m => m.dependabotPRs ?? 0);
    charts.push({
      name: 'github-vulnerabilities',
      svg: barChart({
        series: [{ name: 'Open', color: '#d04437', points: vulns }],
        labels,
        title: `${team.displayName} — Open Vulnerabilities at end of month`
      })
    });
    charts.push({
      name: 'github-dependabot-prs',
      svg: barChart({
        series: [{ name: 'Open', color: '#0052cc', points: prs }],
        labels,
        title: `${team.displayName} — Open Dependabot PRs at end of month`
      })
    });
  }

  return charts;
}
