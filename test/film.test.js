import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFilmPairs, compareFilms, renderFilmCompare } from '../src/film.js';
import { cubicBezier, NAMED_EASINGS } from '../src/easing.js';

const FRAME = 1000 / 60;
const TOTAL = 320 * 180;

/**
 * Synthesize screencast frame-pairs for an object moving with a given easing:
 * pixels changed per pair ~ speed, i.e. the derivative of the easing curve.
 * Centroid tracks the moving object; activity lands in a band of grid cells.
 */
function synthPairs({
  duration = 400,
  easing = NAMED_EASINGS['ease-out'],
  idleBefore = 6,
  idleAfter = 8,
  cellRow = 2,
  pathY = 0.3,
} = {}) {
  const f = cubicBezier(...easing);
  const pairs = [];
  let t = 0;
  const push = (changed, progress) => {
    const cells = new Array(12 * 8).fill(0);
    if (changed > 0) {
      // Activity in the row the object crosses, at its current column.
      const col = Math.min(11, Math.floor(progress * 12));
      cells[cellRow * 12 + col] = changed;
    }
    pairs.push({
      t0: t,
      t1: t + FRAME,
      changed,
      total: TOTAL,
      cx: changed ? 0.1 + 0.7 * progress : null,
      cy: changed ? pathY : null,
      cells,
    });
    t += FRAME;
  };
  for (let i = 0; i < idleBefore; i++) push(0, 0);
  const start = t;
  while (t - start < duration) {
    const u0 = (t - start) / duration;
    const u1 = Math.min(1, (t + FRAME - start) / duration);
    const changed = Math.round((f(u1) - f(u0)) * 40000);
    push(Math.max(changed, 0), f(u1));
  }
  for (let i = 0; i < idleAfter; i++) push(0, 1);
  return pairs;
}

test('analyzeFilmPairs measures duration and easing from pixel motion alone', () => {
  const analysis = analyzeFilmPairs(synthPairs({ duration: 400, easing: NAMED_EASINGS['ease-out'] }));
  assert.equal(analysis.moved, true);
  assert.ok(Math.abs(analysis.activeMs - 400) < 3 * FRAME, `activeMs ${analysis.activeMs}`);
  assert.equal(analysis.easing.name, 'ease-out');
  assert.ok(analysis.centroidPath.length > 5);
  const activeCells = analysis.activityMap.filter((s) => s > 0.01).length;
  assert.ok(activeCells >= 3, 'activity spread across the motion band');

  // Frame-by-frame context for movement matching.
  assert.ok(analysis.frameData.length > 5, 'frameData present');
  assert.ok(analysis.frameData.every((f, i, a) => i === 0 || f.ms >= a[i - 1].ms), 'timestamps monotonic');
  assert.ok(analysis.frameData.some((f) => f.changedPct > 0 && f.cx !== null));
  assert.match(analysis.signature, /^[▁▂▃▄▅▆▇█]+$/);
});

test('similar movements produce similar signatures at different durations', () => {
  const a = analyzeFilmPairs(synthPairs({ duration: 300, easing: NAMED_EASINGS['ease-out'] }));
  const b = analyzeFilmPairs(synthPairs({ duration: 600, easing: NAMED_EASINGS['ease-out'] }));
  const c = analyzeFilmPairs(synthPairs({ duration: 300, easing: NAMED_EASINGS['ease-in'] }));
  const diff = (x, y) => {
    let d = 0;
    for (let i = 0; i < x.length; i++) d += Math.abs(x.charCodeAt(i) - y.charCodeAt(i));
    return d / x.length;
  };
  assert.equal(a.signature.length, b.signature.length);
  // Same easing at double duration reads as the same movement; a reversed
  // easing profile reads as a different one.
  assert.ok(diff(a.signature, b.signature) < diff(a.signature, c.signature));
});

test('analyzeFilmPairs reports stillness as no motion', () => {
  const still = Array.from({ length: 20 }, (_, i) => ({
    t0: i * FRAME,
    t1: (i + 1) * FRAME,
    changed: 0,
    total: TOTAL,
    cx: null,
    cy: null,
    cells: new Array(96).fill(0),
  }));
  assert.equal(analyzeFilmPairs(still).moved, false);
});

test('compareFilms passes identical motion and flags nothing', () => {
  const a = analyzeFilmPairs(synthPairs());
  const b = analyzeFilmPairs(synthPairs());
  const cmp = compareFilms(a, b);
  assert.equal(cmp.score, 1);
  assert.equal(cmp.issues.length, 0);
});

test('compareFilms flags duration drift', () => {
  const a = analyzeFilmPairs(synthPairs({ duration: 400 }));
  const b = analyzeFilmPairs(synthPairs({ duration: 750 }));
  const cmp = compareFilms(a, b);
  assert.ok(cmp.score < 1);
  const issue = cmp.issues.find((i) => i.type === 'duration');
  assert.ok(issue && issue.deltaMs > 250, JSON.stringify(cmp.issues));
});

test('compareFilms flags a different easing curve', () => {
  const a = analyzeFilmPairs(synthPairs({ easing: NAMED_EASINGS['ease-out'] }));
  const b = analyzeFilmPairs(synthPairs({ easing: NAMED_EASINGS['ease-in'] }));
  const cmp = compareFilms(a, b);
  assert.ok(cmp.issues.some((i) => i.type === 'easing'), JSON.stringify(cmp.issues));
});

test('compareFilms flags motion happening somewhere else on screen', () => {
  const a = analyzeFilmPairs(synthPairs({ cellRow: 1, pathY: 0.2 }));
  const b = analyzeFilmPairs(synthPairs({ cellRow: 6, pathY: 0.85 }));
  const cmp = compareFilms(a, b);
  const spatial = cmp.issues.find((i) => i.type === 'spatial');
  assert.ok(spatial, JSON.stringify(cmp.issues));
  assert.ok(spatial.missingRegions.length > 0);
});

test('compareFilms flags missing motion entirely', () => {
  const a = analyzeFilmPairs(synthPairs());
  const still = analyzeFilmPairs(
    Array.from({ length: 20 }, (_, i) => ({
      t0: i * FRAME, t1: (i + 1) * FRAME, changed: 0, total: TOTAL, cx: null, cy: null,
      cells: new Array(96).fill(0),
    }))
  );
  const cmp = compareFilms(a, still);
  assert.equal(cmp.score, 0);
  assert.match(cmp.issues[0].detail, /no motion/);
});

test('renderFilmCompare reads as verdicts with aligned signatures', () => {
  const a = analyzeFilmPairs(synthPairs({ duration: 400 }));
  const b = analyzeFilmPairs(synthPairs({ duration: 750 }));
  const text = renderFilmCompare(compareFilms(a, b), a, b);
  assert.match(text, /visual replication score/);
  assert.match(text, /motion spans \d+ms vs reference \d+ms/);
  assert.match(text, /reference motion: [▁▂▃▄▅▆▇█]+ \(\d+ms\)/);
  assert.match(text, /replica motion: {3}[▁▂▃▄▅▆▇█]+ \(\d+ms\)/);
});
