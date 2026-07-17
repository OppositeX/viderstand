import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, findSegments } from '../src/analyze.js';
import { cubicBezier, NAMED_EASINGS } from '../src/easing.js';
import { renderReport, toJSON } from '../src/report.js';
import { expectAnimation, firstSegment, AnimationAssertionError } from '../src/assert.js';

const FRAME = 1000 / 60;

/**
 * Synthesize a 60fps recording: idle, then `tx` animates from..to over
 * `duration` with the given easing, then idle again.
 */
function synthRecording({
  from = 0,
  to = 200,
  duration = 300,
  easing = NAMED_EASINGS['ease-out'],
  idleBefore = 12,
  idleAfter = 20,
} = {}) {
  const f = cubicBezier(...easing);
  const samples = [];
  let t = 0;
  const base = { x: 10, y: 20, w: 80, h: 80, opacity: 1, ty: 0, scaleX: 1, scaleY: 1, rotate: 0 };
  for (let i = 0; i < idleBefore; i++) {
    samples.push({ t, ...base, tx: from });
    t += FRAME;
  }
  const startT = t;
  while (t - startT <= duration) {
    const u = (t - startT) / duration;
    samples.push({ t, ...base, tx: from + (to - from) * f(Math.min(1, u)) });
    t += FRAME;
  }
  for (let i = 0; i < idleAfter; i++) {
    samples.push({ t, ...base, tx: to });
    t += FRAME;
  }
  return { samples, declared: [{ type: 'CSSTransition', duration, delay: 0, easing: 'ease-out', iterations: 1 }] };
}

test('findSegments locates a single motion run', () => {
  const times = [0, 16, 32, 48, 64, 80, 96, 112];
  const values = [0, 0, 10, 30, 60, 80, 80, 80];
  const segs = findSegments(times, values, 0.25);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].startIdx, 1);
  assert.equal(segs[0].endIdx, 5);
});

test('findSegments merges single-frame stalls and splits real gaps', () => {
  const times = Array.from({ length: 40 }, (_, i) => i * 16);
  const values = times.map((_, i) => {
    if (i < 5) return 0;
    if (i < 12) return (i - 4) * 10; // motion 1
    if (i < 25) return 80; // long gap
    if (i < 32) return 80 + (i - 24) * 10; // motion 2
    return 150;
  });
  const segs = findSegments(times, values, 0.25);
  assert.equal(segs.length, 2);
});

test('analyze measures duration, distance, and easing of synthetic motion', () => {
  const analysis = analyze(synthRecording({ duration: 300, to: 200 }));
  const seg = firstSegment(analysis, 'tx');

  assert.ok(Math.abs(seg.durationMs - 300) < 2 * FRAME, `duration ${seg.durationMs}`);
  assert.ok(Math.abs(seg.distance - 200) < 1, `distance ${seg.distance}`);
  assert.equal(seg.easing.name, 'ease-out');
  assert.ok(seg.easing.confident);
  assert.equal(seg.spring.isSpring, false);
  assert.ok(seg.peakVelocityPerSec > 200, `peak velocity ${seg.peakVelocityPerSec}`);

  // Declared-intent comparison should see the match.
  assert.ok(Math.abs(seg.vsDeclared.durationDeltaMs) < 2 * FRAME);

  // Only tx should register as animated.
  assert.deepEqual(Object.keys(analysis.channels), ['tx']);
});

test('analyze frame stats on clean 60fps input', () => {
  const analysis = analyze(synthRecording());
  const f = analysis.frameStats;
  assert.ok(Math.abs(f.avgFps - 60) < 2, `fps ${f.avgFps}`);
  assert.equal(f.droppedFrames, 0);
});

test('analyze detects dropped frames', () => {
  const rec = synthRecording();
  // Simulate one long frame mid-animation by shifting subsequent timestamps.
  const idx = 18;
  for (let i = idx; i < rec.samples.length; i++) rec.samples[i].t += 34;
  const analysis = analyze(rec);
  assert.ok(analysis.frameStats.droppedFrames >= 1);
  assert.ok(analysis.frameStats.worstFrameMs > 40);
});

test('renderReport and toJSON produce sane output', () => {
  const analysis = analyze(synthRecording());
  const report = renderReport(analysis);
  assert.match(report, /tx: 0px → 200px/);
  assert.match(report, /easing ≈ ease-out/);
  assert.match(report, /progress: [▁▂▃▄▅▆▇█]+/);
  assert.match(report, /curve detail/);

  const json = toJSON(analysis);
  assert.equal(json.channels.tx.segments[0].points, undefined);
  assert.equal(typeof json.channels.tx.segments[0].durationMs, 'number');
});

test('assertions pass and fail with useful messages', () => {
  const analysis = analyze(synthRecording({ duration: 300, to: 200 }));
  const seg = firstSegment(analysis, 'tx');

  expectAnimation(seg)
    .toHaveDuration(300, { tolerance: 35 })
    .toMatchEasing('ease-out')
    .toTravel(200, { tolerance: 2 });

  assert.throws(
    () => expectAnimation(seg).toHaveDuration(500, { tolerance: 30 }),
    (err) => err instanceof AnimationAssertionError && /not within ±30ms of 500ms/.test(err.message)
  );
  assert.throws(
    () => expectAnimation(seg).toMatchEasing('ease-in'),
    (err) => /closest to "ease-out"/.test(err.message)
  );
  assert.throws(() => firstSegment(analysis, 'opacity'), /expected "opacity" to animate/);
});
