/**
 * Scene analysis and replication diffing.
 *
 * analyzeScene() runs the per-channel measurement over every element the
 * scene probe discovered. compareScenes() diffs a reference recording
 * against a replica recording and returns a measured verdict for every
 * animated element and channel — the answer to "did I replicate it
 * correctly?" as numbers instead of eyeballing.
 */
import { analyze, frameStats } from './analyze.js';
import { cubicBezier } from './easing.js';
import { sparkline } from './report.js';

function colorDistance(cur, base) {
  if (!cur || !base) return 0;
  return Math.hypot(cur[0] - base[0], cur[1] - base[1], cur[2] - base[2], (cur[3] - base[3]) * 255);
}

/**
 * Expand raw probe frames into flat numeric samples: colors become a single
 * "distance from initial color" channel, so color transitions get the same
 * duration/easing treatment as motion.
 */
function expandFrames(frames) {
  const base = frames[0];
  return frames.map((f) => ({
    t: f.t,
    x: f.x, y: f.y, w: f.w, h: f.h,
    opacity: f.opacity,
    tx: f.tx, ty: f.ty, scaleX: f.scaleX, scaleY: f.scaleY, rotate: f.rotate,
    radius: f.radius,
    bgColor: colorDistance(f.bg, base.bg),
    fgColor: colorDistance(f.fg, base.fg),
  }));
}

/**
 * @param {{elements: {key, frames}[], ticks: number[], warnings: string[]}} recording
 * @returns {{elements: Record<string, analysis>, frameStats, warnings}}
 */
export function analyzeScene(recording) {
  const elements = {};
  for (const el of recording.elements) {
    if (el.frames.length < 5) continue;
    let analysis;
    try {
      analysis = analyze({ samples: expandFrames(el.frames) });
    } catch {
      continue;
    }
    if (Object.keys(analysis.channels).length === 0) continue;
    // Element frames are sparse outside motion; the scene-level ticks below
    // are the honest pacing record, so drop the per-element one.
    delete analysis.frameStats;
    elements[el.key] = analysis;
  }
  const t0 = recording.ticks[0] ?? 0;
  return {
    elements,
    frameStats: frameStats(recording.ticks.map((t) => t - t0)),
    warnings: recording.warnings ?? [],
  };
}

function sceneStart(scene) {
  let min = Infinity;
  for (const el of Object.values(scene.elements)) {
    for (const ch of Object.values(el.channels)) {
      for (const seg of ch.segments) min = Math.min(min, seg.startMs);
    }
  }
  return Number.isFinite(min) ? min : 0;
}

/** RMSE between two fitted bezier curves, sampled across normalized time. */
export function curveDistance(paramsA, paramsB) {
  const a = cubicBezier(...paramsA);
  const b = cubicBezier(...paramsB);
  let sum = 0;
  const N = 21;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const e = a(u) - b(u);
    sum += e * e;
  }
  return Math.sqrt(sum / (N + 1));
}

function compareSegments(refSeg, repSeg, refT0, repT0, tol) {
  const issues = [];

  const dTol = Math.max(tol.durationMs, refSeg.durationMs * tol.durationPct);
  const dDelta = repSeg.durationMs - refSeg.durationMs;
  if (Math.abs(dDelta) > dTol) {
    issues.push({ type: 'duration', ref: refSeg.durationMs, replica: repSeg.durationMs, deltaMs: Math.round(dDelta) });
  }

  const distTol = Math.max(tol.distanceAbs, refSeg.distance * tol.distancePct);
  if (Math.abs(repSeg.distance - refSeg.distance) > distTol) {
    issues.push({ type: 'distance', ref: refSeg.distance, replica: repSeg.distance });
  }

  const refSpring = refSeg.spring?.isSpring;
  const repSpring = repSeg.spring?.isSpring;
  if (refSpring !== repSpring) {
    issues.push({
      type: 'easing',
      detail: refSpring ? 'reference is spring-like, replica is not' : 'replica is spring-like, reference is not',
    });
  } else if (refSpring && repSpring) {
    if (Math.abs(refSeg.spring.overshootRatio - repSeg.spring.overshootRatio) > tol.overshoot) {
      issues.push({
        type: 'easing',
        detail: `overshoot ${Math.round(repSeg.spring.overshootRatio * 100)}% vs reference ${Math.round(refSeg.spring.overshootRatio * 100)}%`,
      });
    }
  } else {
    const rmse = curveDistance(refSeg.easing.fitted.params, repSeg.easing.fitted.params);
    if (rmse > tol.easingRmse) {
      issues.push({
        type: 'easing',
        ref: refSeg.easing.name,
        replica: repSeg.easing.name,
        curveRmse: Math.round(rmse * 1000) / 1000,
      });
    }
  }

  const refOffset = refSeg.startMs - refT0;
  const repOffset = repSeg.startMs - repT0;
  const staggerTol = Math.max(tol.staggerMs, refSeg.durationMs * 0.15);
  if (Math.abs(repOffset - refOffset) > staggerTol) {
    issues.push({
      type: 'stagger',
      refOffsetMs: Math.round(refOffset),
      replicaOffsetMs: Math.round(repOffset),
    });
  }

  return issues;
}

const DEFAULT_TOLERANCE = {
  durationMs: 35,
  durationPct: 0.1,
  distanceAbs: 3,
  distancePct: 0.08,
  easingRmse: 0.045,
  overshoot: 0.08,
  staggerMs: 40,
};

/**
 * Diff a replica scene against a reference scene.
 * Elements are matched by their discovered key (#id or css path).
 */
export function compareScenes(refScene, repScene, tolerance = {}) {
  const tol = { ...DEFAULT_TOLERANCE, ...tolerance };
  const refT0 = sceneStart(refScene);
  const repT0 = sceneStart(repScene);

  const elements = [];
  let total = 0;
  let ok = 0;

  for (const [key, refEl] of Object.entries(refScene.elements)) {
    const repEl = repScene.elements[key];
    if (!repEl) {
      const channelCount = Object.keys(refEl.channels).length;
      total += channelCount;
      elements.push({ key, status: 'missing-or-still', refChannels: Object.keys(refEl.channels) });
      continue;
    }
    const channels = [];
    for (const [name, refCh] of Object.entries(refEl.channels)) {
      total++;
      const repCh = repEl.channels[name];
      if (!repCh) {
        channels.push({ channel: name, status: 'not-animated' });
        continue;
      }
      const issues = compareSegments(refCh.segments[0], repCh.segments[0], refT0, repT0, tol);
      if (issues.length === 0) {
        ok++;
        channels.push({ channel: name, status: 'ok' });
      } else {
        channels.push({ channel: name, status: 'mismatch', issues });
      }
    }
    for (const name of Object.keys(repEl.channels)) {
      if (!refEl.channels[name]) channels.push({ channel: name, status: 'extra-animation' });
    }
    elements.push({ key, status: 'compared', channels });
  }

  const extraElements = Object.keys(repScene.elements).filter((k) => !refScene.elements[k]);
  const score = total === 0 ? 1 : Math.round((ok / total) * 1000) / 1000;

  return { score, elements, extraElements, comparedChannels: total, matchedChannels: ok };
}

function describeIssue(issue) {
  switch (issue.type) {
    case 'duration':
      return `duration ${issue.replica}ms vs reference ${issue.ref}ms (${issue.deltaMs > 0 ? '+' : ''}${issue.deltaMs}ms)`;
    case 'distance':
      return `travels ${issue.replica} vs reference ${issue.ref}`;
    case 'easing':
      return issue.detail
        ? `easing: ${issue.detail}`
        : `easing "${issue.replica}" vs reference "${issue.ref}" (curve rmse ${issue.curveRmse})`;
    case 'stagger':
      return `starts at +${issue.replicaOffsetMs}ms vs reference +${issue.refOffsetMs}ms`;
    default:
      return JSON.stringify(issue);
  }
}

export function renderCompareReport(cmp) {
  const out = [];
  const pct = Math.round(cmp.score * 100);
  out.push(
    `replication score: ${pct}% (${cmp.matchedChannels}/${cmp.comparedChannels} animated channels match the reference)`
  );
  for (const el of cmp.elements) {
    if (el.status === 'missing-or-still') {
      out.push(`  ✗ ${el.key}: animates in the reference (${el.refChannels.join(', ')}) but not in the replica`);
      continue;
    }
    for (const ch of el.channels) {
      if (ch.status === 'ok') {
        out.push(`  ✓ ${el.key} ${ch.channel}`);
      } else if (ch.status === 'not-animated') {
        out.push(`  ✗ ${el.key} ${ch.channel}: animates in the reference but not in the replica`);
      } else if (ch.status === 'extra-animation') {
        out.push(`  ✗ ${el.key} ${ch.channel}: animates in the replica but not in the reference`);
      } else {
        for (const issue of ch.issues) {
          out.push(`  ✗ ${el.key} ${ch.channel}: ${describeIssue(issue)}`);
        }
      }
    }
  }
  for (const key of cmp.extraElements) {
    out.push(`  ✗ ${key}: animates in the replica but not in the reference`);
  }
  return out.join('\n');
}

export function renderSceneReport(scene) {
  const out = [];
  const keys = Object.keys(scene.elements);
  out.push(`scene: ${keys.length} element(s) animated`);
  if (scene.frameStats) {
    const f = scene.frameStats;
    out.push(
      `frames: ${f.avgFps}fps avg, ${f.droppedFrames} dropped (worst ${f.worstFrameMs}ms) over ${f.frames} frames`
    );
  }
  for (const warning of scene.warnings ?? []) out.push(`warning: ${warning}`);
  for (const [key, el] of Object.entries(scene.elements)) {
    for (const [name, ch] of Object.entries(el.channels)) {
      for (const seg of ch.segments) {
        const shape = seg.spring?.isSpring
          ? `spring (overshoot ${Math.round(seg.spring.overshootRatio * 100)}%)`
          : seg.easing.confident
            ? seg.easing.name
            : `cubic-bezier(${seg.easing.fitted.params.join(', ')})`;
        out.push(
          `  ${key} ${name}: ${seg.from}${ch.unit} → ${seg.to}${ch.unit} in ${seg.durationMs}ms at t+${seg.startMs}ms, ${shape}`
        );
        out.push(`    ${sparkline(seg.points.map((p) => p.p))}`);
      }
    }
  }
  return out.join('\n');
}
