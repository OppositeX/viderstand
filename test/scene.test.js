import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareScenes, curveDistance, renderCompareReport, analyzeScene } from '../src/scene.js';
import { NAMED_EASINGS, cubicBezier } from '../src/easing.js';

function segment({
  startMs = 100,
  durationMs = 300,
  distance = 200,
  easing = 'ease-out',
  spring = { isSpring: false },
} = {}) {
  const params = NAMED_EASINGS[easing];
  return {
    startMs,
    durationMs,
    from: 0,
    to: distance,
    distance,
    peakVelocityPerSec: 1000,
    spring,
    easing: spring.isSpring
      ? null
      : { name: easing, namedRmse: 0.001, namedParams: params, fitted: { params, rmse: 0.001 }, confident: true },
    points: [],
  };
}

function scene(elements) {
  const out = { elements: {} };
  for (const [key, channels] of Object.entries(elements)) {
    out.elements[key] = { channels: {} };
    for (const [ch, seg] of Object.entries(channels)) {
      out.elements[key].channels[ch] = { unit: 'px', segments: [seg] };
    }
  }
  return out;
}

test('curveDistance separates unlike curves, not identical ones', () => {
  assert.ok(curveDistance(NAMED_EASINGS['ease-out'], NAMED_EASINGS['ease-out']) < 1e-9);
  assert.ok(curveDistance(NAMED_EASINGS['ease-out'], NAMED_EASINGS.linear) > 0.05);
  assert.ok(curveDistance(NAMED_EASINGS['ease-in'], NAMED_EASINGS['ease-out']) > 0.1);
});

test('identical scenes score 1 with no issues', () => {
  const ref = scene({ '#a': { tx: segment() }, '#b': { opacity: segment({ distance: 0.8 }) } });
  const rep = scene({ '#a': { tx: segment() }, '#b': { opacity: segment({ distance: 0.8 }) } });
  const cmp = compareScenes(ref, rep);
  assert.equal(cmp.score, 1);
  assert.ok(cmp.elements.every((e) => e.status !== 'missing-or-still'));
});

test('duration drift is flagged with the delta', () => {
  const ref = scene({ '#a': { tx: segment({ durationMs: 300 }) } });
  const rep = scene({ '#a': { tx: segment({ durationMs: 550 }) } });
  const cmp = compareScenes(ref, rep);
  assert.ok(cmp.score < 1);
  const issues = cmp.elements[0].channels[0].issues;
  assert.equal(issues[0].type, 'duration');
  assert.equal(issues[0].deltaMs, 250);
});

test('wrong easing is flagged via curve distance', () => {
  const ref = scene({ '#a': { tx: segment({ easing: 'ease-out' }) } });
  const rep = scene({ '#a': { tx: segment({ easing: 'linear' }) } });
  const cmp = compareScenes(ref, rep);
  const issues = cmp.elements[0].channels[0].issues;
  assert.ok(issues.some((i) => i.type === 'easing'));
});

test('small measurement jitter passes within tolerance', () => {
  const ref = scene({ '#a': { tx: segment({ durationMs: 300, distance: 200, startMs: 100 }) } });
  const rep = scene({ '#a': { tx: segment({ durationMs: 315, distance: 198, startMs: 118 }) } });
  assert.equal(compareScenes(ref, rep).score, 1);
});

test('missing element, missing channel, and extras are all reported', () => {
  const ref = scene({ '#a': { tx: segment(), opacity: segment({ distance: 0.8 }) }, '#c': { tx: segment() } });
  const rep = scene({ '#a': { tx: segment(), rotate: segment() }, '#d': { tx: segment() } });
  const cmp = compareScenes(ref, rep);

  const a = cmp.elements.find((e) => e.key === '#a');
  assert.ok(a.channels.some((c) => c.channel === 'opacity' && c.status === 'not-animated'));
  assert.ok(a.channels.some((c) => c.channel === 'rotate' && c.status === 'extra-animation'));
  const c = cmp.elements.find((e) => e.key === '#c');
  assert.equal(c.status, 'missing-or-still');
  assert.deepEqual(cmp.extraElements, ['#d']);
  assert.equal(cmp.score, 0.333); // only #a tx of the three reference channels matches
});

test('spring-vs-eased mismatch is an easing issue', () => {
  const ref = scene({
    '#a': { ty: segment({ spring: { isSpring: true, overshootRatio: 0.15, oscillations: 2, settleU: 0.8 } }) },
  });
  const rep = scene({ '#a': { ty: segment({ easing: 'ease-out' }) } });
  const issues = compareScenes(ref, rep).elements[0].channels[0].issues;
  assert.ok(issues.some((i) => i.type === 'easing' && /spring/.test(i.detail)));
});

test('renderCompareReport reads as verdicts', () => {
  const ref = scene({ '#a': { tx: segment({ durationMs: 300 }) }, '#c': { tx: segment() } });
  const rep = scene({ '#a': { tx: segment({ durationMs: 550 }) } });
  const text = renderCompareReport(compareScenes(ref, rep));
  assert.match(text, /replication score: /);
  assert.match(text, /#a tx: duration 550ms vs reference 300ms \(\+250ms\)/);
  assert.match(text, /#c: animates in the reference .* but not in the replica/);
});

test('analyzeScene turns raw frames into per-element channels, colors included', () => {
  const FRAME = 1000 / 60;
  const ease = cubicBezier(...NAMED_EASINGS['ease-out']);
  const frames = [];
  const base = {
    x: 10, y: 10, w: 50, h: 50, opacity: 1,
    ty: 0, scaleX: 1, scaleY: 1, rotate: 0, radius: 0, fg: [0, 0, 0, 1],
  };
  let t = 0;
  for (let i = 0; i < 10; i++) {
    frames.push({ t, ...base, tx: 0, bg: [10, 20, 30, 1] });
    t += FRAME;
  }
  const start = t;
  while (t - start <= 300) {
    const p = ease(Math.min(1, (t - start) / 300));
    frames.push({ t, ...base, tx: 200 * p, bg: [10 + 120 * p, 20, 30, 1] });
    t += FRAME;
  }
  for (let i = 0; i < 15; i++) {
    frames.push({ t, ...base, tx: 200, bg: [130, 20, 30, 1] });
    t += FRAME;
  }
  const ticks = frames.map((f) => f.t);

  const scene = analyzeScene({ elements: [{ key: '#a', frames }], ticks, warnings: [] });
  const channels = scene.elements['#a'].channels;
  assert.ok(channels.tx, 'tx channel detected');
  assert.ok(channels.bgColor, 'background color transition detected');
  assert.ok(Math.abs(channels.tx.segments[0].durationMs - 300) < 2 * FRAME);
  assert.equal(channels.tx.segments[0].easing.name, 'ease-out');
});
