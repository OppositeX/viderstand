/**
 * End-to-end against real Chromium: record the fixture page and verify the
 * measured numbers match what the CSS declares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { record, analyze, firstSegment, expectAnimation, renderReport } from '../src/index.js';

const fixture = fileURLToPath(new URL('../examples/fixture.html', import.meta.url));

test('measures the 400ms ease-in-out slide', { timeout: 60_000 }, async () => {
  const recording = await record({
    url: fixture,
    selector: '#box',
    trigger: 'click:#slide',
  });
  const analysis = analyze(recording);
  const seg = firstSegment(analysis, 'tx');

  expectAnimation(seg)
    .toHaveDuration(400, { tolerance: 60 })
    .toMatchEasing('ease-in-out', { maxRmse: 0.04 })
    .toTravel(240, { tolerance: 3 });

  // Declared intent captured from the Web Animations API.
  assert.ok(recording.declared.length >= 1, 'expected a declared CSS transition');
  assert.ok(recording.declared.some((d) => d.duration === 400));

  // The report should read like something an agent can act on.
  const report = renderReport(analysis);
  assert.match(report, /ease-in-out/);
});

test('measures the 250ms ease-out fade', { timeout: 60_000 }, async () => {
  const recording = await record({
    url: fixture,
    selector: '#box',
    trigger: 'click:#fade',
  });
  const seg = firstSegment(analyze(recording), 'opacity');

  expectAnimation(seg)
    .toHaveDuration(250, { tolerance: 50 })
    .toMatchEasing('ease-out', { maxRmse: 0.04 });
  assert.ok(Math.abs(seg.to - 0.2) < 0.02, `faded to ${seg.to}`);
});

test('detects overshoot in the WAAPI spring', { timeout: 60_000 }, async () => {
  const recording = await record({
    url: fixture,
    selector: '#box',
    trigger: 'click:#spring',
  });
  const seg = firstSegment(analyze(recording), 'ty');

  expectAnimation(seg).toBeSpring({ minOvershoot: 0.05 });
  assert.ok(Math.abs(seg.to - 200) < 3, `settled at ${seg.to}`);
  assert.ok(Math.abs(seg.durationMs - 600) < 80, `duration ${seg.durationMs}`);
});
