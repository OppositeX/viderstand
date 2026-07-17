/**
 * End-to-end film mode: real Chromium screencast, pixel-only analysis, and a
 * visual comparison that needs no selectors or IDs at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { recordFilm, compareFilms } from '../src/index.js';

const reference = fileURLToPath(new URL('../examples/reference.html', import.meta.url));
const replicaBad = fileURLToPath(new URL('../examples/replica-bad.html', import.meta.url));

const scratch = process.env.CLAUDE_SCRATCHPAD_DIR || tmpdir();

test('film captures screencast frames and measures motion from pixels', { timeout: 90_000 }, async () => {
  const outDir = mkdtempSync(join(scratch, 'film-'));
  const result = await recordFilm({ url: reference, trigger: 'click:#play', outDir });

  assert.ok(result.frameCount >= 5, `only ${result.frameCount} frames`);
  const a = result.analysis;
  assert.equal(a.moved, true);
  // Reference scene: longest transition is 400ms (plus #b's 100ms delay tail).
  assert.ok(a.activeMs >= 250 && a.activeMs <= 650, `activeMs ${a.activeMs}`);
  assert.ok(a.activityMap.some((s) => s > 0.03), 'activity map populated');
  assert.ok(existsSync(join(outDir, 'contact-sheet.png')), 'contact sheet written');
  assert.ok(existsSync(join(outDir, 'frame-000.png')), 'frames written');
});

test('visual compare: reference vs itself is clean, vs bad replica is not', { timeout: 180_000 }, async () => {
  const ref1 = await recordFilm({ url: reference, trigger: 'click:#play' });
  const ref2 = await recordFilm({ url: reference, trigger: 'click:#play' });
  const bad = await recordFilm({ url: replicaBad, trigger: 'click:#play' });

  const self = compareFilms(ref1.analysis, ref2.analysis);
  assert.ok(self.score >= 0.75, `self-compare score ${self.score}: ${JSON.stringify(self.issues)}`);
  assert.ok(!self.issues.some((i) => i.type === 'duration'), 'no duration issue against itself');

  const cmp = compareFilms(ref1.analysis, bad.analysis);
  assert.ok(cmp.score < 1);
  // #a runs 700ms instead of 400ms — the pixel record must show it.
  const duration = cmp.issues.find((i) => i.type === 'duration');
  assert.ok(duration, `expected duration issue: ${JSON.stringify(cmp.issues)}`);
  assert.ok(duration.deltaMs > 150, `delta ${duration.deltaMs}`);
});
