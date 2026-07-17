/**
 * Render an analysis as text. This is the bridge back to the agent: curves
 * become sparklines and ASCII plots, judgments become sentences with numbers.
 */

const SPARK = '▁▂▃▄▅▆▇█';

export function sparkline(values, width = 48) {
  if (values.length === 0) return '';
  const step = values.length / width;
  const picked = [];
  for (let i = 0; i < width; i++) {
    picked.push(values[Math.min(values.length - 1, Math.floor(i * step))]);
  }
  const min = Math.min(...picked);
  const max = Math.max(...picked);
  const span = max - min || 1;
  return picked
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor(((v - min) / span) * SPARK.length))])
    .join('');
}

/**
 * ASCII plot of progress vs normalized time — lets a text-only reader
 * literally see the easing shape.
 */
export function asciiPlot(points, { width = 60, height = 14 } = {}) {
  const ps = points.map((pt) => pt.p);
  const min = Math.min(0, ...ps);
  const max = Math.max(1, ...ps);
  const grid = Array.from({ length: height }, () => new Array(width).fill(' '));
  for (const { u, p } of points) {
    const col = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
    const row = Math.min(
      height - 1,
      Math.max(0, height - 1 - Math.round(((p - min) / (max - min)) * (height - 1)))
    );
    grid[row][col] = '•';
  }
  const oneRow = height - 1 - Math.round(((1 - min) / (max - min)) * (height - 1));
  const lines = grid.map((row, i) => {
    const label = i === oneRow ? '1.0' : i === height - 1 ? '0.0' : '   ';
    let line = row.join('');
    if (i === oneRow) line = line.replace(/ /g, '·');
    return `${label} │${line}`;
  });
  lines.push(`    └${'─'.repeat(width)}`);
  lines.push(`     0${' '.repeat(width - 8)}t → 1`);
  return lines.join('\n');
}

function describeSegment(name, unit, seg, index, total) {
  const lines = [];
  const label = total > 1 ? `${name} (segment ${index + 1}/${total})` : name;
  const motion = `${seg.from}${unit} → ${seg.to}${unit} (${seg.distance}${unit})`;
  lines.push(`  ${label}: ${motion} in ${seg.durationMs}ms, starting at t+${seg.startMs}ms`);
  lines.push(`    peak velocity: ${seg.peakVelocityPerSec}${unit}/s`);

  if (seg.spring.isSpring) {
    const s = seg.spring;
    lines.push(
      `    spring-like: overshoots by ${Math.round(s.overshootRatio * 100)}%, ` +
        `${s.oscillations} oscillation(s), settles at ${Math.round(s.settleU * 100)}% of the segment`
    );
  } else if (seg.easing) {
    const e = seg.easing;
    const fitted = `cubic-bezier(${e.fitted.params.join(', ')})`;
    if (e.confident) {
      lines.push(`    easing ≈ ${e.name} (rmse ${e.namedRmse}); free fit ${fitted} (rmse ${e.fitted.rmse})`);
    } else {
      lines.push(
        `    easing: no clean named match — closest is ${e.name} (rmse ${e.namedRmse}), ` +
          `measured curve is ${fitted} (rmse ${e.fitted.rmse})`
      );
    }
  }

  if (seg.vsDeclared) {
    const d = seg.vsDeclared;
    const drift = d.durationDeltaMs;
    const verdict =
      Math.abs(drift) <= Math.max(20, d.declaredDurationMs * 0.05)
        ? 'matches declared timing'
        : `DRIFTS ${drift > 0 ? '+' : ''}${drift}ms from declared`;
    lines.push(`    declared: ${d.declaredDurationMs}ms / ${d.declaredEasing} — measured ${verdict}`);
  }

  lines.push(`    progress: ${sparkline(seg.points.map((p) => p.p))}`);
  return lines.join('\n');
}

/**
 * Full human/agent-readable report.
 */
export function renderReport(analysis, { plot = true } = {}) {
  const out = [];
  const channelEntries = Object.entries(analysis.channels);

  out.push(
    `viderstand: ${analysis.sampleCount} frames over ${analysis.recordingMs}ms, ` +
      `${channelEntries.length} animated propert${channelEntries.length === 1 ? 'y' : 'ies'}`
  );

  if (analysis.frameStats) {
    const f = analysis.frameStats;
    const smooth = f.droppedFrames === 0 ? 'smooth' : `${f.droppedFrames} dropped frame(s)`;
    out.push(
      `frames: ${f.avgFps}fps avg (median frame ${f.medianFrameMs}ms, worst ${f.worstFrameMs}ms) — ${smooth}`
    );
  }

  if (channelEntries.length === 0) {
    out.push('no property changed beyond the noise floor — nothing animated.');
    return out.join('\n');
  }

  out.push('');
  let primary = null;
  for (const [name, ch] of channelEntries) {
    ch.segments.forEach((seg, i) => {
      out.push(describeSegment(name, ch.unit, seg, i, ch.segments.length));
      if (!primary || seg.distance * seg.durationMs > primary.seg.distance * primary.seg.durationMs) {
        primary = { name, seg };
      }
    });
  }

  if (plot && primary) {
    out.push('');
    out.push(`  curve detail — ${primary.name} (progress vs time):`);
    out.push(asciiPlot(primary.seg.points));
  }

  return out.join('\n');
}

/**
 * Compact JSON meant for machine consumption (strips raw point arrays).
 */
export function toJSON(analysis, { includePoints = false } = {}) {
  const clone = structuredClone(analysis);
  if (!includePoints) {
    for (const ch of Object.values(clone.channels)) {
      for (const seg of ch.segments) delete seg.points;
    }
  }
  return clone;
}
