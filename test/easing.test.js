import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cubicBezier,
  classifyEasing,
  fitCubicBezier,
  analyzeSpring,
  NAMED_EASINGS,
} from '../src/easing.js';

function samplesFrom(params, { n = 40, noise = 0 } = {}) {
  const f = cubicBezier(...params);
  const points = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    points.push({ u, p: f(u) + (noise ? (Math.sin(i * 999.7) * noise) : 0) });
  }
  return points;
}

test('cubicBezier endpoints and linearity', () => {
  const linear = cubicBezier(...NAMED_EASINGS.linear);
  assert.equal(linear(0), 0);
  assert.equal(linear(1), 1);
  assert.ok(Math.abs(linear(0.5) - 0.5) < 1e-4);
  assert.ok(Math.abs(linear(0.25) - 0.25) < 1e-4);
});

test('cubicBezier ease-in starts slow, ease-out starts fast', () => {
  const easeIn = cubicBezier(...NAMED_EASINGS['ease-in']);
  const easeOut = cubicBezier(...NAMED_EASINGS['ease-out']);
  assert.ok(easeIn(0.25) < 0.15, `ease-in(0.25)=${easeIn(0.25)}`);
  assert.ok(easeOut(0.25) > 0.35, `ease-out(0.25)=${easeOut(0.25)}`);
});

test('classifyEasing recovers each named easing from clean samples', () => {
  for (const [name, params] of Object.entries(NAMED_EASINGS)) {
    const result = classifyEasing(samplesFrom(params));
    assert.equal(result.name, name, `expected ${name}, got ${result.name} (rmse ${result.namedRmse})`);
    assert.ok(result.namedRmse < 0.005, `${name} rmse too high: ${result.namedRmse}`);
  }
});

test('classifyEasing tolerates measurement noise', () => {
  const result = classifyEasing(samplesFrom(NAMED_EASINGS['ease-in-out'], { noise: 0.008 }));
  assert.equal(result.name, 'ease-in-out');
  assert.ok(result.confident);
});

test('fitCubicBezier recovers unnamed curve parameters', () => {
  const truth = [0.7, 0.1, 0.3, 0.9]; // not in the named table
  const { params, rmse } = fitCubicBezier(samplesFrom(truth));
  assert.ok(rmse < 0.005, `fit rmse ${rmse}`);
  // The curve shape must match even if parameters aren't unique.
  const f = cubicBezier(...truth);
  const g = cubicBezier(...params);
  for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    assert.ok(Math.abs(f(u) - g(u)) < 0.02, `mismatch at u=${u}`);
  }
});

test('classifyEasing flags a non-named curve as not confident', () => {
  const weird = samplesFrom([0.9, 0.05, 0.1, 0.95]);
  const result = classifyEasing(weird);
  assert.equal(result.confident, false);
});

test('analyzeSpring detects overshoot and settle', () => {
  // Damped oscillation: p = 1 - e^(-5u) * cos(12u)
  const points = [];
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    points.push({ u, p: 1 - Math.exp(-5 * u) * Math.cos(12 * u) });
  }
  const spring = analyzeSpring(points);
  assert.equal(spring.isSpring, true);
  assert.ok(spring.overshootRatio > 0.1, `overshoot ${spring.overshootRatio}`);
  assert.ok(spring.oscillations >= 1);
});

test('analyzeSpring ignores plain eased motion', () => {
  const spring = analyzeSpring(samplesFrom(NAMED_EASINGS['ease-out']));
  assert.equal(spring.isSpring, false);
});
