// Server-rendered SVG charts (no client library; works under the strict CSP).
// Specs: 2px lines with a ~10% area wash, columns <= 24px with a 4px rounded data-end and a square
// baseline, hairline solid gridlines, >= 8px end markers with a 2px surface ring, selective labels
// (last and extreme values only). Colors come from CSS tokens so light/dark themes both apply.
// Every chart has an invisible per-slot hit layer (wider than the mark) for the tooltip script.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function niceScale(max, ticks = 4, integer = false) {
  if (!max || max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  if (integer) step = Math.max(1, Math.ceil(step)); // counts never get fractional ticks
  return { top: step * Math.ceil(max / step), step };
}

function frame({ points, height, fmt, yMax, W }) {
  const vals = points.map((p) => p.value).filter((v) => v !== null && v !== undefined);
  const integer = vals.every((v) => Number.isInteger(v)) && (!yMax || Number.isInteger(yMax));
  const { top, step } = niceScale(Math.max(yMax || 0, ...vals, 0), 4, integer);
  const pad = { l: 56, r: 24, t: 20, b: 30 };
  const plotW = W - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const slot = plotW / Math.max(points.length, 1);
  const x = (i) => pad.l + slot * i + slot / 2;
  const y = (v) => pad.t + plotH - (v / top) * plotH;
  let grid = '';
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid += `<line class="ch-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
    grid += `<text class="ch-tick" x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  }
  // X labels: thin out so they never collide (at most ~8).
  // On narrow screens every other shown label hides (class ch-xl-alt) so month names never collide.
  const every = Math.ceil(points.length / 8);
  let xl = '';
  points.forEach((p, i) => {
    if ((points.length - 1 - i) % every !== 0) return;
    const alt = (points.length - 1 - i) / every;
    xl += `<text class="ch-tick${alt % 2 ? ' ch-xl-alt' : ''}" x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(p.short || p.label)}</text>`;
  });
  return { pad, plotW, plotH, slot, x, y, top, grid, xl, W };
}

function hitLayer(points, f, height, fmt) {
  return points.map((p, i) => `<rect class="ch-hit" x="${(f.pad.l + f.slot * i).toFixed(1)}" y="0" width="${f.slot.toFixed(1)}" height="${height - f.pad.b}" tabindex="0" `
    + `data-x="${f.x(i).toFixed(1)}" data-tip-label="${esc(p.label)}" data-tip-value="${esc(p.value === null || p.value === undefined ? '—' : fmt(p.value))}" aria-label="${esc(p.label)}: ${esc(p.value === null || p.value === undefined ? '—' : fmt(p.value))}"/>`).join('');
}

function wrap(svg, { title, height, W }) {
  return `<div class="chart" data-chart><svg class="ch" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(title)}" dir="ltr" preserveAspectRatio="xMidYMid meet">${svg}</svg><div class="chart-tip" hidden><strong data-tip-value></strong><span data-tip-label></span></div></div>`;
}

/** Single-series line (trend over time). Null values leave a gap. */
function line({ points, title, fmt = String, height = 220, yMax, width = 640 }) {
  const f = frame({ points, height, fmt, yMax, W: width });
  const segs = [];
  let cur = [];
  points.forEach((p, i) => {
    if (p.value === null || p.value === undefined) { if (cur.length) segs.push(cur); cur = []; } else cur.push([f.x(i), f.y(p.value)]);
  });
  if (cur.length) segs.push(cur);
  const base = f.y(0);
  let marks = '';
  for (const s of segs) {
    const d = s.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    if (s.length > 1) marks += `<path class="ch-area" d="${d} L${s[s.length - 1][0].toFixed(1)},${base.toFixed(1)} L${s[0][0].toFixed(1)},${base.toFixed(1)} Z"/>`;
    marks += `<path class="ch-line" d="${d}"/>`;
  }
  // End marker + label on the last value.
  const lastI = points.map((p) => p.value).map((v, i) => (v === null || v === undefined ? -1 : i)).filter((i) => i >= 0).pop();
  if (lastI !== undefined) {
    const lx = f.x(lastI); const ly = f.y(points[lastI].value);
    marks += `<circle class="ch-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4"/>`;
    marks += `<text class="ch-label" x="${(lx - 8).toFixed(1)}" y="${(ly - 10).toFixed(1)}" text-anchor="end">${esc(fmt(points[lastI].value))}</text>`;
  }
  const cross = `<line class="ch-cross" x1="0" x2="0" y1="${f.pad.t}" y2="${height - f.pad.b}" visibility="hidden"/>`;
  return wrap(`${f.grid}${f.xl}${cross}${marks}${hitLayer(points, f, height, fmt)}`, { title, height, W: f.W });
}

/** Single-series columns over time; the highest value is labelled. */
function columns({ points, title, fmt = String, height = 200, yMax, width = 640 }) {
  const f = frame({ points, height, fmt, yMax, W: width });
  const bw = Math.min(24, f.slot - 2);
  const base = f.y(0);
  const max = Math.max(...points.map((p) => p.value || 0));
  // Label one column only: the most recent occurrence of the highest value.
  const labelAt = points.map((p) => p.value || 0).lastIndexOf(max);
  let marks = '';
  points.forEach((p, i) => {
    if (!p.value) return;
    const x0 = f.x(i) - bw / 2; const top = f.y(p.value); const h = base - top; const r = Math.min(4, h, bw / 2);
    marks += `<path class="ch-bar" d="M${x0.toFixed(1)},${base.toFixed(1)} V${(top + r).toFixed(1)} Q${x0.toFixed(1)},${top.toFixed(1)} ${(x0 + r).toFixed(1)},${top.toFixed(1)} H${(x0 + bw - r).toFixed(1)} Q${(x0 + bw).toFixed(1)},${top.toFixed(1)} ${(x0 + bw).toFixed(1)},${(top + r).toFixed(1)} V${base.toFixed(1)} Z"/>`;
    if (i === labelAt) marks += `<text class="ch-label" x="${f.x(i).toFixed(1)}" y="${(top - 6).toFixed(1)}" text-anchor="middle">${esc(fmt(p.value))}</text>`;
  });
  return wrap(`${f.grid}${f.xl}${marks}${hitLayer(points, f, height, fmt)}`, { title, height, W: f.W });
}

/** Horizontal bars for categories (HTML, so long names wrap and RTL works). Every bar is labelled at its tip. */
function bars({ items, fmt = String, max, emptyLabel = '—' }) {
  const top = max || Math.max(...items.map((i) => i.value || 0), 1);
  return `<div class="hbars">${items.map((i) => `<div class="hbar"><span class="hbar-label" dir="auto">${esc(i.label || emptyLabel)}</span>`
    + `<span class="hbar-track"><span class="hbar-fill" style="width:${Math.max(0, Math.min(100, ((i.value || 0) / top) * 100)).toFixed(1)}%"></span></span>`
    + `<span class="hbar-value num">${esc(i.value === null || i.value === undefined ? '—' : fmt(i.value))}${i.note ? `<span class="muted tiny"> ${esc(i.note)}</span>` : ''}</span></div>`).join('')}</div>`;
}

module.exports = { line, columns, bars, niceScale };
