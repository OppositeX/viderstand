/**
 * End-to-end scene mode in real Chromium: the observer must discover every
 * animated element on its own, and compare() must catch exactly the three
 * planted defects in the bad replica.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { recordScene, analyzeScene, compareScenes, compare } from '../src/index.js';

const reference = fileURLToPath(new URL('../examples/reference.html', import.meta.url));
const replicaBad = fileURLToPath(new URL('../examples/replica-bad.html', import.meta.url));

test('scene observer discovers all animated elements without selectors', { timeout: 60_000 }, async () => {
  const scene = analyzeScene(
    await recordScene({ url: reference, trigger: 'click:#play' })
  );

  assert.ok(scene.elements['#a'], '#a discovered');
  assert.ok(scene.elements['#b'], '#b discovered');
  assert.ok(scene.elements['#c'], '#c discovered');

  const a = scene.elements['#a'].channels.tx.segments[0];
  assert.ok(Math.abs(a.durationMs - 400) < 60, `#a duration ${a.durationMs}`);
  assert.equal(a.easing.name, 'ease-in-out');

  const b = scene.elements['#b'].channels.opacity.segments[0];
  assert.ok(Math.abs(b.durationMs - 250) < 50, `#b duration ${b.durationMs}`);

  const c = scene.elements['#c'].channels.scaleX.segments[0];
  assert.ok(Math.abs(c.to - 1.5) < 0.05, `#c scales to ${c.to}`);
});

test('reference compared to itself scores 1', { timeout: 90_000 }, async () => {
  const opts = { url: reference, trigger: 'click:#play' };
  const result = await compare(opts, { ...opts });
  assert.equal(result.comparison.score, 1, result.report);
});

test('compare catches exactly the planted defects in the bad replica', { timeout: 90_000 }, async () => {
  const refScene = analyzeScene(await recordScene({ url: reference, trigger: 'click:#play' }));
  const repScene = analyzeScene(await recordScene({ url: replicaBad, trigger: 'click:#play' }));
  const cmp = compareScenes(refScene, repScene);

  assert.ok(cmp.score < 1);

  // #a: 700ms instead of 400ms.
  const a = cmp.elements.find((e) => e.key === '#a');
  const aTx = a.channels.find((c) => c.channel === 'tx');
  assert.equal(aTx.status, 'mismatch');
  const durationIssue = aTx.issues.find((i) => i.type === 'duration');
  assert.ok(durationIssue, 'duration issue on #a');
  assert.ok(durationIssue.deltaMs > 200, `delta ${durationIssue.deltaMs}`);

  // #b: linear instead of ease-out.
  const b = cmp.elements.find((e) => e.key === '#b');
  const bOp = b.channels.find((c) => c.channel === 'opacity');
  assert.ok(bOp.issues?.some((i) => i.type === 'easing'), 'easing issue on #b');

  // #c: does not animate at all in the replica.
  const c = cmp.elements.find((e) => e.key === '#c');
  assert.equal(c.status, 'missing-or-still');
});
