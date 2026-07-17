/**
 * Playwright driver: opens a page, installs the per-frame probe, fires the
 * trigger, waits for motion to settle, and returns raw samples plus the
 * page's declared animation intent (Web Animations API).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { chromium } from 'playwright-core';
import { installProbe } from './probe.js';
import { installSceneProbe } from './scene-probe.js';
import { film } from './film.js';

function resolveChromiumExecutable(explicit) {
  if (explicit) return explicit;
  if (process.env.VIDERSTAND_CHROMIUM) return process.env.VIDERSTAND_CHROMIUM;

  const candidates = ['/opt/pw-browsers/chromium']; // Claude Code cloud sandbox
  // Any Playwright-managed chromium, newest revision first.
  const home = homedir();
  for (const cache of [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, '.cache', 'ms-playwright'),
    join(home, 'Library', 'Caches', 'ms-playwright'),
    join(home, 'AppData', 'Local', 'ms-playwright'),
  ]) {
    if (!cache) continue;
    let dirs = [];
    try {
      dirs = readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const d of dirs) {
      candidates.push(
        join(cache, d, 'chrome-linux', 'chrome'),
        join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(cache, d, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(cache, d, 'chrome-win', 'chrome.exe')
      );
    }
  }
  // System browsers as a last resort.
  candidates.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  );

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined; // let playwright-core resolve its own installation
}

export function toUrl(target) {
  if (/^https?:\/\//.test(target) || target.startsWith('file://')) return target;
  return pathToFileURL(resolvePath(target)).href;
}

export function launchBrowser(options = {}) {
  return chromium.launch({
    executablePath: resolveChromiumExecutable(options.executablePath),
    args: ['--disable-lcd-text', '--force-device-scale-factor=1'],
  });
}

export async function runTrigger(page, trigger) {
  if (!trigger || trigger === 'none') return;
  if (typeof trigger === 'function') {
    await trigger(page);
    return;
  }
  const [kind, ...rest] = trigger.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'click':
      await page.click(arg);
      break;
    case 'hover':
      await page.hover(arg);
      break;
    case 'focus':
      await page.focus(arg);
      break;
    case 'js':
      await page.evaluate(arg);
      break;
    default:
      throw new Error(
        `viderstand: unknown trigger "${trigger}" (use click:<sel>, hover:<sel>, focus:<sel>, js:<expr>, or none)`
      );
  }
}

/**
 * Record per-frame samples of an element.
 *
 * @param {object} options
 * @param {string} options.url        Page URL or local file path.
 * @param {string} options.selector   Element to observe.
 * @param {string|Function} [options.trigger]  What starts the animation:
 *        "click:<sel>", "hover:<sel>", "focus:<sel>", "js:<expr>", "none",
 *        or an async (page) => {} function.
 * @param {number} [options.maxDuration=4000]  Hard cap on recording (ms).
 * @param {number} [options.idleMs=600]        Stop after this much stillness.
 * @param {string[]} [options.properties]      Extra numeric CSS properties to
 *                                             sample (e.g. "border-radius").
 * @param {object} [options.viewport]
 * @param {string} [options.executablePath]
 * @param {Function} [options.setup]           async (page) => {} run after
 *                                             load, before the probe starts.
 * @returns {Promise<{samples: object[], declared: object[]}>}
 */
export async function record(options) {
  const {
    url,
    selector,
    trigger = 'none',
    maxDuration = 4000,
    idleMs = 600,
    properties = [],
    viewport = { width: 1280, height: 720 },
    executablePath,
    setup,
  } = options;
  if (!url || !selector) throw new Error('viderstand: record() requires url and selector');

  const browser = await chromium.launch({
    executablePath: resolveChromiumExecutable(executablePath),
    // Deterministic frame pacing matters more than raster fidelity here.
    args: ['--disable-lcd-text', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(toUrl(url), { waitUntil: 'load' });
    if (setup) await setup(page);
    await page.waitForSelector(selector, { state: 'attached' });

    await page.evaluate(installProbe, { selector, properties });
    // A short baseline so segment detection has pre-motion frames to anchor on.
    await page.waitForTimeout(120);

    await runTrigger(page, trigger);
    // Let the animation start, then snapshot declared intent while it's live.
    await page.waitForTimeout(60);
    await page.evaluate(() => window.__viderstand.captureDeclared());

    const started = Date.now();
    while (Date.now() - started < maxDuration) {
      await page.waitForTimeout(100);
      const status = await page.evaluate(() => window.__viderstand.status());
      if (status.now - status.lastChangeT > idleMs) break;
    }

    return await page.evaluate(() => window.__viderstand.stop());
  } finally {
    await browser.close();
  }
}

/**
 * Record the whole scene with the self-updating observer: no selector
 * needed — every element that animates is discovered and sampled. Use this
 * when replicating a reference and you can't know in advance what moves.
 *
 * Options are the same as record() minus `selector`/`properties`, plus:
 * @param {string} [options.root]         Subtree to observe (default body).
 * @param {number} [options.maxElements]  Cap on tracked elements.
 * @returns {Promise<{elements: {key, frames}[], ticks: number[], warnings: string[]}>}
 */
export async function recordScene(options) {
  const {
    url,
    root,
    trigger = 'none',
    maxDuration = 4000,
    idleMs = 600,
    maxElements,
    viewport = { width: 1280, height: 720 },
    executablePath,
    setup,
  } = options;
  if (!url) throw new Error('viderstand: recordScene() requires url');

  const browser = await chromium.launch({
    executablePath: resolveChromiumExecutable(executablePath),
    args: ['--disable-lcd-text', '--force-device-scale-factor=1'],
  });
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(toUrl(url), { waitUntil: 'load' });
    if (setup) await setup(page);
    if (root) await page.waitForSelector(root, { state: 'attached' });

    await page.evaluate(installSceneProbe, { root, maxElements });
    await page.waitForTimeout(120);

    await runTrigger(page, trigger);

    const started = Date.now();
    while (Date.now() - started < maxDuration) {
      await page.waitForTimeout(100);
      const status = await page.evaluate(() => window.__viderstand.status());
      if (status.now - status.lastChangeT > idleMs) break;
    }

    return await page.evaluate(() => window.__viderstand.stop());
  } finally {
    await browser.close();
  }
}

/**
 * Record a film: CDP screencast frames + pixel-derived motion analysis +
 * a contact-sheet image. Fully identity-free — no selectors involved.
 */
export function recordFilm(options) {
  return film(options, { launchBrowser, toUrl, runTrigger });
}
