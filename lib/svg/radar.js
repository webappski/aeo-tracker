import { TOKENS, FONT_SANS, esc } from './tokens.js';

/**
 * Radar chart — per-engine coverage in one visual.
 *
 * Visual system v2 — amber fill on warm grid, engine labels in sans with
 * a small percentage sub-label in ink3. Empty (0%) axes get a hollow ring
 * marker at the centre to signal "invisible on this axis" without the
 * red-dot alarmism of v1.
 *
 * @param {Object} opts
 * @param {Array<{label:string,value:number}>} opts.axes   0–100 value per axis
 * @param {number} [opts.size=340]
 */
export function radar({ axes, size = 340 }) {
  if (!Array.isArray(axes) || axes.length < 3) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"></svg>`;
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 54;
  const n = axes.length;
  const angleFor = (i) => (-Math.PI / 2) + (2 * Math.PI * i / n);

  // Reference rings at 25/50/75/100
  const rings = [0.25, 0.5, 0.75, 1.0].map(frac => {
    const r = radius * frac;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = angleFor(i);
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    const opacity = frac === 1 ? 1 : 0.6;
    return `<polygon points="${pts}" fill="none" stroke="${TOKENS.border}" stroke-width="1" opacity="${opacity}"/>`;
  }).join('');

  // Ring-percentage labels along the top axis
  const ringLabels = [0.25, 0.5, 0.75, 1.0].map(frac => {
    const y = cy - radius * frac;
    return `<text x="${cx + 4}" y="${y + 3}" font-size="9" font-family="${FONT_SANS}" fill="${TOKENS.ink4}">${Math.round(frac * 100)}</text>`;
  }).join('');

  // Axis lines
  const axisLines = axes.map((_, i) => {
    const a = angleFor(i);
    const x2 = (cx + radius * Math.cos(a)).toFixed(1);
    const y2 = (cy + radius * Math.sin(a)).toFixed(1);
    return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${TOKENS.border}" stroke-width="1"/>`;
  }).join('');

  // Data polygon (amber)
  const dataPts = axes.map((ax, i) => {
    const a = angleFor(i);
    const frac = Math.max(0, Math.min(100, ax.value || 0)) / 100;
    const r = radius * frac;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
  const dataPolygon = `<polygon points="${dataPts}" fill="${TOKENS.accent}" fill-opacity="0.18" stroke="${TOKENS.accent}" stroke-width="1.75"/>`;

  // Vertex dots — hollow ring at centre if value is 0 (instead of red alarm)
  const dots = axes.map((ax, i) => {
    const a = angleFor(i);
    const v = Math.max(0, Math.min(100, ax.value || 0));
    const frac = v / 100;
    const r = radius * frac;
    const x = (cx + r * Math.cos(a)).toFixed(1);
    const y = (cy + r * Math.sin(a)).toFixed(1);
    if (v === 0) {
      return `<circle cx="${x}" cy="${y}" r="4" fill="${TOKENS.bgRaised}" stroke="${TOKENS.ink4}" stroke-width="1.25" stroke-dasharray="1.5 1.5"/>`;
    }
    return `<circle cx="${x}" cy="${y}" r="3.5" fill="${TOKENS.accent}" stroke="${TOKENS.bgRaised}" stroke-width="1.5"/>`;
  }).join('');

  // Outside labels
  const labels = axes.map((ax, i) => {
    const a = angleFor(i);
    const labelRadius = radius + 24;
    const x = cx + labelRadius * Math.cos(a);
    const y = cy + labelRadius * Math.sin(a);
    let anchor = 'middle';
    if (Math.cos(a) > 0.3) anchor = 'start';
    else if (Math.cos(a) < -0.3) anchor = 'end';
    const dy = Math.sin(a) > 0.3 ? 12 : (Math.sin(a) < -0.3 ? -2 : 4);
    // `data-axis` + `data-value` on the value label so downstream tests
    // (and DOM-inspect tooling) can verify the painted value of each axis
    // without parsing the polygon-points string. Pure annotation — has no
    // visual effect on rendering.
    const rounded = Math.round(ax.value || 0);
    const value = `${rounded}%`;
    return `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" font-size="12" font-family="${FONT_SANS}" font-weight="600" fill="${TOKENS.ink}">${esc(ax.label)}</text>` +
           `<text data-axis="${esc(ax.label)}" data-value="${rounded}" x="${x.toFixed(1)}" y="${(y + dy + 14).toFixed(1)}" text-anchor="${anchor}" font-size="10.5" font-family="${FONT_SANS}" fill="${TOKENS.ink3}" letter-spacing="0.02em">${value}</text>`;
  }).join('');

  // viewBox is padded horizontally so axis labels (e.g. "Sentiment", "Mentions"
  // — 8-9 chars at font-size 12 ≈ 60-70px wide) fit fully outside the polygon
  // without being clipped at the SVG edge. Polygon coordinates stay in the
  // 0..size range; the negative left and extra right give label room without
  // shrinking the radar itself. `max-width` matches the new visible width.
  const labelPad = Math.round(size * 0.18);
  const visibleWidth = size + labelPad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-labelPad} 0 ${visibleWidth} ${size}" width="100%" style="max-width:${visibleWidth}px;height:auto;background:${TOKENS.bgRaised};">${rings}${axisLines}${ringLabels}${dataPolygon}${dots}${labels}</svg>`;
}
