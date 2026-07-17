/**
 * Film mode: identity-free, purely visual measurement.
 *
 * The DOM-trace modes need matching element identities between reference and
 * replica — which a rebuilt page never has. Film mode instead captures what
 * the compositor actually paints, via the CDP screencast (a frame is pushed
 * every time pixels change, with real timestamps — far denser than polled
 * screenshots), and derives everything from pixels:
 *
 *   - motion energy per frame-pair  -> when the scene moves, for how long
 *   - cumulative motion             -> the easing curve of the scene
 *   - changed-pixel centroids       -> the path the motion travels
 *   - a spatial activity grid       -> where on screen things move
 *   - a contact sheet               -> a filmstrip image the agent can SEE
 *
 * Comparing two films needs no selectors and no IDs at all.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEasing, cubicBezier } from './easing.js';

// Grid used for the spatial activity signature.
const GX = 12;
const GY = 8;

/* ------------------------------------------------------------------ */
/* In-browser workers (serialized by Playwright; must be self-contained) */
/* ------------------------------------------------------------------ */

async function extractMotionInPage(frames) {
  const W = 320;
  const GX = 12;
  const GY = 8;
  const load = (u) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = u;
    });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let H = 0;
  let prev = null;
  let prevT = 0;
  const pairs = [];

  for (const frame of frames) {
    const img = await load(frame.u);
    if (!H) {
      H = Math.max(1, Math.round((img.height * W) / img.width));
      canvas.width = W;
      canvas.height = H;
    }
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    if (prev) {
      let changed = 0;
      let sx = 0;
      let sy = 0;
      const cells = new Array(GX * GY).fill(0);
      for (let y = 0; y < H; y++) {
        const gy = Math.floor((y * GY) / H);
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const d =
            Math.abs(data[i] - prev[i]) +
            Math.abs(data[i + 1] - prev[i + 1]) +
            Math.abs(data[i + 2] - prev[i + 2]);
          if (d > 40) {
            changed++;
            sx += x;
            sy += y;
            cells[gy * GX + Math.floor((x * GX) / W)]++;
          }
        }
      }
      pairs.push({
        t0: prevT,
        t1: frame.t,
        changed,
        total: W * H,
        cx: changed ? sx / changed / W : null,
        cy: changed ? sy / changed / H : null,
        cells,
      });
    }
    prev = data;
    prevT = frame.t;
  }
  return pairs;
}

async function contactSheetInPage({ frames, cols, thumbW }) {
  const load = (u) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = u;
    });
  const images = [];
  for (const f of frames) images.push({ img: await load(f.u), t: f.t });

  const ratio = images[0].img.height / images[0].img.width;
  const thumbH = Math.round(thumbW * ratio);
  const label = 16;
  const rows = Math.ceil(images.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * thumbW;
  canvas.height = rows * (thumbH + label);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '11px monospace';
  ctx.textBaseline = 'top';

  images.forEach(({ img, t }, i) => {
    const x = (i % cols) * thumbW;
    const y = Math.floor(i / cols) * (thumbH + label);
    ctx.drawImage(img, x, y, thumbW, thumbH);
    ctx.fillStyle = '#111';
    ctx.fillRect(x, y + thumbH, thumbW, label);
    ctx.fillStyle = '#9f9';
    ctx.fillText(`t+${Math.round(t)}ms`, x + 4, y + thumbH + 3);
    ctx.strokeStyle = '#333';
    ctx.strokeRect(x + 0.5, y + 0.5, thumbW - 1, thumbH + label - 1);
  });
  return canvas.toDataURL('image/png');
}

/* ------------------------------------------------------------------ */
/* Pure analysis (no browser needed — unit-testable)                    */
/* ------------------------------------------------------------------ */

/**
 * Turn frame-pair motion data into a film analysis.
 * pairs: [{t0, t1, changed, total, cx, cy, cells}]
 */
export function analyzeFilmPairs(pairs, { activeRatio = 0.0006, gapMs = 120 } = {}) {
  if (!pairs || pairs.length === 0) {
    throw new Error('viderstand: no frame pairs to analyze (did anything change on screen?)');
  }
  const active = pairs.filter((p) => p.changed / p.total > activeRatio);
  if (active.length === 0) {
    return { moved: false, activeMs: 0, frames: pairs.length + 1 };
  }

  // Group active pairs into bursts separated by > gapMs of stillness, then
  // measure the overall active window and the dominant burst.
  const bursts = [];
  let cur = null;
  for (const p of active) {
    if (cur && p.t0 - cur.end <= gapMs) {
      cur.end = p.t1;
      cur.pairs.push(p);
    } else {
      cur = { start: p.t0, end: p.t1, pairs: [p] };
      bursts.push(cur);
    }
  }
  const main = bursts.reduce((a, b) =>
    b.pairs.reduce((s, p) => s + p.changed, 0) > a.pairs.reduce((s, p) => s + p.changed, 0) ? b : a
  );

  // Easing of the scene: cumulative pixel change over the main burst. For a
  // moving object, pixels changed per frame ~ speed, so the cumulative curve
  // approximates displacement progress — an easing curve, from pixels alone.
  const duration = main.end - main.start;
  let totalChanged = 0;
  for (const p of main.pairs) totalChanged += p.changed;
  const points = [{ u: 0, p: 0 }];
  let acc = 0;
  for (const p of main.pairs) {
    acc += p.changed;
    points.push({ u: Math.min(1, (p.t1 - main.start) / duration), p: acc / totalChanged });
  }
  const easing = classifyEasing(points);

  // Where things moved: activity share per grid cell across all activity.
  const cells = new Array(GX * GY).fill(0);
  let all = 0;
  for (const p of active) {
    for (let i = 0; i < cells.length; i++) cells[i] += p.cells[i];
    all += p.changed;
  }
  const activityMap = cells.map((c) => (all ? c / all : 0));

  // The path the motion's center of mass travels, normalized time and space.
  const centroidPath = main.pairs
    .filter((p) => p.cx !== null)
    .map((p) => ({ u: Math.min(1, (p.t1 - main.start) / duration), cx: p.cx, cy: p.cy }));

  return {
    moved: true,
    frames: pairs.length + 1,
    activeStartMs: Math.round(active[0].t0),
    activeMs: Math.round(active[active.length - 1].t1 - active[0].t0),
    mainBurstMs: Math.round(duration),
    bursts: bursts.length,
    easing,
    points,
    activityMap,
    centroidPath,
    peakChangedRatio: Math.max(...active.map((p) => p.changed / p.total)),
  };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function regionName(idx) {
  const gx = idx % GX;
  const gy = Math.floor(idx / GX);
  const h = ['left', 'center', 'right'][Math.min(2, Math.floor((gx * 3) / GX))];
  const v = ['top', 'middle', 'bottom'][Math.min(2, Math.floor((gy * 3) / GY))];
  return `${v}-${h}`;
}

function pathAt(path, u) {
  if (path.length === 0) return null;
  let best = path[0];
  for (const p of path) if (Math.abs(p.u - u) < Math.abs(best.u - u)) best = p;
  return best;
}

const FILM_TOLERANCE = {
  durationMs: 60,
  durationPct: 0.15,
  easingRmse: 0.08,
  spatialSimilarity: 0.6,
  regionShare: 0.05,
  pathDistance: 0.09,
};

/**
 * Compare two film analyses — no selectors, no IDs, pixels only.
 */
export function compareFilms(ref, rep, tolerance = {}) {
  const tol = { ...FILM_TOLERANCE, ...tolerance };
  const issues = [];

  if (!ref.moved && !rep.moved) return { score: 1, issues, verdict: 'neither film contains motion' };
  if (ref.moved !== rep.moved) {
    issues.push({
      type: 'motion',
      detail: ref.moved ? 'reference animates but the replica shows no motion' : 'replica animates but the reference does not',
    });
    return { score: 0, issues };
  }

  const checks = [];

  const dTol = Math.max(tol.durationMs, ref.activeMs * tol.durationPct);
  const dDelta = rep.activeMs - ref.activeMs;
  const durationOk = Math.abs(dDelta) <= dTol;
  checks.push(durationOk);
  if (!durationOk) {
    issues.push({ type: 'duration', ref: ref.activeMs, replica: rep.activeMs, deltaMs: Math.round(dDelta) });
  }

  let easingRmse = 0;
  {
    const a = cubicBezier(...ref.easing.fitted.params);
    const b = cubicBezier(...rep.easing.fitted.params);
    let sum = 0;
    for (let i = 0; i <= 20; i++) {
      const e = a(i / 20) - b(i / 20);
      sum += e * e;
    }
    easingRmse = Math.sqrt(sum / 21);
  }
  const easingOk = easingRmse <= tol.easingRmse;
  checks.push(easingOk);
  if (!easingOk) {
    issues.push({
      type: 'easing',
      ref: ref.easing.name,
      replica: rep.easing.name,
      curveRmse: Math.round(easingRmse * 1000) / 1000,
    });
  }

  const similarity = cosine(ref.activityMap, rep.activityMap);
  const spatialOk = similarity >= tol.spatialSimilarity;
  checks.push(spatialOk);
  if (!spatialOk) {
    const missing = new Set();
    const extra = new Set();
    for (let i = 0; i < ref.activityMap.length; i++) {
      if (ref.activityMap[i] > tol.regionShare && rep.activityMap[i] < ref.activityMap[i] * 0.25) {
        missing.add(regionName(i));
      }
      if (rep.activityMap[i] > tol.regionShare && ref.activityMap[i] < rep.activityMap[i] * 0.25) {
        extra.add(regionName(i));
      }
    }
    issues.push({
      type: 'spatial',
      similarity: Math.round(similarity * 1000) / 1000,
      missingRegions: [...missing],
      extraRegions: [...extra],
    });
  }

  if (ref.centroidPath.length > 2 && rep.centroidPath.length > 2) {
    let sum = 0;
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const a = pathAt(ref.centroidPath, i / N);
      const b = pathAt(rep.centroidPath, i / N);
      sum += Math.hypot(a.cx - b.cx, a.cy - b.cy);
    }
    const pathDist = sum / (N + 1);
    const pathOk = pathDist <= tol.pathDistance;
    checks.push(pathOk);
    if (!pathOk) {
      issues.push({ type: 'path', distance: Math.round(pathDist * 1000) / 1000 });
    }
  }

  const score = Math.round((checks.filter(Boolean).length / checks.length) * 1000) / 1000;
  return { score, issues, spatialSimilarity: Math.round(similarity * 1000) / 1000 };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                            */
/* ------------------------------------------------------------------ */

export function renderFilmReport(analysis) {
  if (!analysis.moved) return `film: ${analysis.frames} frames captured, no motion detected`;
  const out = [];
  out.push(
    `film: ${analysis.frames} frames; motion starts at t+${analysis.activeStartMs}ms and spans ${analysis.activeMs}ms` +
      (analysis.bursts > 1 ? ` in ${analysis.bursts} bursts` : '')
  );
  const e = analysis.easing;
  out.push(
    e.confident
      ? `scene easing ≈ ${e.name} (rmse ${e.namedRmse})`
      : `scene easing: cubic-bezier(${e.fitted.params.join(', ')}) — closest named ${e.name} (rmse ${e.namedRmse})`
  );
  const byRegion = new Map();
  analysis.activityMap.forEach((share, i) => {
    const name = regionName(i);
    byRegion.set(name, (byRegion.get(name) ?? 0) + share);
  });
  const hot = [...byRegion.entries()]
    .filter(([, share]) => share > 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, share]) => `${name} ${Math.round(share * 100)}%`);
  out.push(`activity regions: ${hot.join(', ')}`);
  return out.join('\n');
}

export function renderFilmCompare(cmp) {
  const out = [];
  out.push(`visual replication score: ${Math.round(cmp.score * 100)}%`);
  if (cmp.issues.length === 0) {
    out.push('  ✓ motion timing, easing, location, and path all match the reference');
  }
  for (const issue of cmp.issues) {
    switch (issue.type) {
      case 'motion':
        out.push(`  ✗ ${issue.detail}`);
        break;
      case 'duration':
        out.push(`  ✗ motion spans ${issue.replica}ms vs reference ${issue.ref}ms (${issue.deltaMs > 0 ? '+' : ''}${issue.deltaMs}ms)`);
        break;
      case 'easing':
        out.push(`  ✗ motion curve differs: "${issue.replica}" vs reference "${issue.ref}" (curve rmse ${issue.curveRmse})`);
        break;
      case 'spatial':
        out.push(
          `  ✗ motion happens in different places (similarity ${issue.similarity})` +
            (issue.missingRegions.length ? `; reference regions with no replica motion: ${issue.missingRegions.join(', ')}` : '') +
            (issue.extraRegions.length ? `; replica-only motion: ${issue.extraRegions.join(', ')}` : '')
        );
        break;
      case 'path':
        out.push(`  ✗ motion follows a different path (mean centroid distance ${issue.distance})`);
        break;
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Capture orchestration                                                */
/* ------------------------------------------------------------------ */

/**
 * Record a film of the page via CDP screencast, extract motion data, and
 * build the contact sheet — the filmstrip the agent can look at.
 *
 * Options: url, trigger, maxDuration, idleMs, viewport, executablePath,
 * setup, outDir (write frames + contact sheet + report there), sheetFrames.
 */
export async function film(options, deps) {
  // deps injected by recorder-side wrapper to avoid a circular import.
  const { launchBrowser, toUrl, runTrigger } = deps;
  const {
    url,
    trigger = 'none',
    maxDuration = 4000,
    idleMs = 700,
    viewport = { width: 1280, height: 720 },
    setup,
    outDir,
    sheetFrames = 18,
  } = options;
  if (!url) throw new Error('viderstand: film() requires url');

  const browser = await launchBrowser(options);
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(toUrl(url), { waitUntil: 'load' });
    if (setup) await setup(page);
    await page.waitForTimeout(200);

    const cdp = await page.context().newCDPSession(page);
    const raw = [];
    cdp.on('Page.screencastFrame', (ev) => {
      raw.push({ b64: ev.data, t: (ev.metadata?.timestamp ?? Date.now() / 1000) * 1000 });
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 800, maxHeight: 800, everyNthFrame: 1 });
    await page.waitForTimeout(80); // capture the resting state first

    await runTrigger(page, trigger);

    const started = Date.now();
    let lastCount = 0;
    let lastGrowth = Date.now();
    while (Date.now() - started < maxDuration) {
      await page.waitForTimeout(100);
      if (raw.length !== lastCount) {
        lastCount = raw.length;
        lastGrowth = Date.now();
      } else if (Date.now() - lastGrowth > idleMs) {
        break;
      }
    }
    await cdp.send('Page.stopScreencast').catch(() => {});

    if (raw.length < 2) {
      throw new Error('viderstand: screencast captured fewer than 2 frames — nothing changed on screen');
    }
    const t0 = raw[0].t;
    const frames = raw.map((f) => ({ u: `data:image/png;base64,${f.b64}`, t: f.t - t0 }));

    // Reuse the same browser as the image processor: pixel diffs and the
    // contact sheet are computed on a canvas, so Node needs no image deps.
    const worker = await browser.newPage();
    const pairs = await worker.evaluate(extractMotionInPage, frames);

    const step = Math.max(1, Math.ceil(frames.length / sheetFrames));
    const sampled = frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
    const sheetDataUrl = await worker.evaluate(contactSheetInPage, {
      frames: sampled,
      cols: 6,
      thumbW: 200,
    });

    const analysis = analyzeFilmPairs(pairs);
    const result = { analysis, pairs, frameCount: raw.length };

    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      raw.forEach((f, i) => {
        writeFileSync(join(outDir, `frame-${String(i).padStart(3, '0')}.png`), Buffer.from(f.b64, 'base64'));
      });
      const sheetPath = join(outDir, 'contact-sheet.png');
      writeFileSync(sheetPath, Buffer.from(sheetDataUrl.split(',')[1], 'base64'));
      writeFileSync(join(outDir, 'film.json'), JSON.stringify({ analysis }, null, 2));
      result.outDir = outDir;
      result.contactSheet = sheetPath;
    } else {
      result.contactSheetDataUrl = sheetDataUrl;
    }
    return result;
  } finally {
    await browser.close();
  }
}
