/**
 * Turn raw per-frame samples into measurements: which properties animated,
 * for how long, along which easing curve, at what velocity, and how smoothly
 * the browser actually rendered it.
 */
import { classifyEasing, analyzeSpring } from './easing.js';

// Per-channel noise floor: a frame-to-frame delta below this is stillness.
const CHANNEL_EPS = {
  x: 0.25,
  y: 0.25,
  w: 0.25,
  h: 0.25,
  tx: 0.25,
  ty: 0.25,
  opacity: 0.004,
  scaleX: 0.002,
  scaleY: 0.002,
  rotate: 0.1,
};

const CHANNEL_UNITS = {
  x: 'px', y: 'px', w: 'px', h: 'px', tx: 'px', ty: 'px',
  opacity: '', scaleX: '×', scaleY: '×', rotate: 'deg',
};

function channelNames(samples) {
  const names = Object.keys(samples[0]).filter((k) => k !== 't');
  return names.filter((name) => samples.every((s) => typeof s[name] === 'number'));
}

/**
 * Find contiguous runs of motion in a value series. Runs separated by a gap
 * of up to `gapFrames` still frames are merged (browsers occasionally hold a
 * value for a frame mid-animation).
 */
export function findSegments(times, values, eps, gapFrames = 3) {
  const moving = [];
  for (let i = 1; i < values.length; i++) {
    moving.push(Math.abs(values[i] - values[i - 1]) > eps);
  }
  const segments = [];
  let start = -1;
  let stillRun = 0;
  for (let i = 0; i < moving.length; i++) {
    if (moving[i]) {
      if (start === -1) start = i; // segment starts at sample index i (value before first move)
      stillRun = 0;
    } else if (start !== -1) {
      stillRun++;
      if (stillRun > gapFrames) {
        segments.push({ startIdx: start, endIdx: i - stillRun + 1 });
        start = -1;
        stillRun = 0;
      }
    }
  }
  if (start !== -1) segments.push({ startIdx: start, endIdx: moving.length - stillRun });
  // Drop blips: segments must span at least 3 frames and move beyond noise.
  return segments.filter((seg) => {
    const span = seg.endIdx - seg.startIdx;
    const dist = Math.abs(values[seg.endIdx] - values[seg.startIdx]);
    return span >= 3 && dist > eps * 4;
  });
}

function analyzeSegment(times, values, seg) {
  const { startIdx, endIdx } = seg;
  const t0 = times[startIdx];
  const t1 = times[endIdx];
  const from = values[startIdx];
  const to = values[endIdx];
  const duration = t1 - t0;
  const range = to - from;

  // Normalized (time, progress) points. Progress may exceed 1 mid-flight —
  // that's exactly what spring detection looks for.
  const points = [];
  for (let i = startIdx; i <= endIdx; i++) {
    points.push({ u: (times[i] - t0) / duration, p: (values[i] - from) / range });
  }

  // Peak velocity in value-units per second.
  let peakVelocity = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const dt = times[i] - times[i - 1];
    if (dt <= 0) continue;
    peakVelocity = Math.max(peakVelocity, Math.abs((values[i] - values[i - 1]) / dt) * 1000);
  }

  const spring = analyzeSpring(points);
  const easing = spring.isSpring ? null : classifyEasing(points);

  // Raw frame-by-frame values (ms from segment start). Kept in JSON output as
  // context: two motions with similar frame profiles are similar movements,
  // even when summary numbers differ.
  const frameData = [];
  for (let i = startIdx; i <= endIdx; i++) {
    frameData.push({ ms: Math.round((times[i] - t0) * 10) / 10, v: Math.round(values[i] * 100) / 100 });
  }

  return {
    startMs: Math.round(t0 * 10) / 10,
    durationMs: Math.round(duration * 10) / 10,
    from: Math.round(from * 100) / 100,
    to: Math.round(to * 100) / 100,
    distance: Math.round(Math.abs(range) * 100) / 100,
    peakVelocityPerSec: Math.round(peakVelocity * 10) / 10,
    easing,
    spring,
    points,
    frameData: subsample(frameData, 80),
  };
}

/** Evenly thin an array to at most max entries, always keeping the last. */
export function subsample(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/**
 * Frame pacing: real fps, dropped frames, worst frame. rAF timestamps expose
 * exactly what the compositor delivered — no screenshot can show this.
 */
export function frameStats(times) {
  const deltas = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  if (deltas.length === 0) return null;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const budget = median * 1.5;
  const dropped = deltas.filter((d) => d > budget).length;
  const worst = Math.max(...deltas);
  const avgFps = 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length);
  return {
    frames: times.length,
    avgFps: Math.round(avgFps * 10) / 10,
    medianFrameMs: Math.round(median * 100) / 100,
    droppedFrames: dropped,
    worstFrameMs: Math.round(worst * 100) / 100,
  };
}

function matchDeclared(declared, segment) {
  if (!declared || declared.length === 0) return null;
  let best = null;
  for (const d of declared) {
    if (typeof d.duration !== 'number') continue;
    const diff = Math.abs(d.duration - segment.durationMs);
    if (!best || diff < best.diff) best = { diff, declared: d };
  }
  if (!best) return null;
  return {
    declaredDurationMs: best.declared.duration,
    declaredEasing: best.declared.easing,
    durationDeltaMs: Math.round((segment.durationMs - best.declared.duration) * 10) / 10,
  };
}

/**
 * Full analysis of a recording.
 *
 * @param {{samples: object[], declared?: object[]}} recording
 * @returns {object} report — see README for the shape.
 */
export function analyze(recording) {
  const { samples, declared = [] } = recording;
  if (!samples || samples.length < 5) {
    throw new Error('viderstand: not enough samples to analyze (need >= 5 frames)');
  }
  const t0 = samples[0].t;
  const times = samples.map((s) => s.t - t0);

  const channels = {};
  for (const name of channelNames(samples)) {
    const values = samples.map((s) => s[name]);
    const eps = CHANNEL_EPS[name] ?? 0.01;
    const segments = findSegments(times, values, eps);
    if (segments.length === 0) continue;
    channels[name] = {
      unit: CHANNEL_UNITS[name] ?? '',
      segments: segments.map((seg) => {
        const result = analyzeSegment(times, values, seg);
        result.vsDeclared = matchDeclared(declared, result);
        return result;
      }),
    };
  }

  return {
    channels,
    frameStats: frameStats(times),
    declared,
    sampleCount: samples.length,
    recordingMs: Math.round(times[times.length - 1] * 10) / 10,
  };
}
