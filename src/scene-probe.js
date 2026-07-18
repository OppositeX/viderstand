/**
 * The scene-wide probe: instead of watching one pre-named element, it
 * discovers what animates by itself. Three detection layers feed a "hot set"
 * of elements that get sampled every frame:
 *
 *   1. MutationObserver — class/style/attribute/DOM changes anywhere in the
 *      subtree mark the target (and its descendants) hot immediately.
 *   2. document.getAnimations() polling — CSS transitions/animations and
 *      WAAPI effects starting on any element mark their target hot.
 *   3. A periodic full sweep — every N frames, every indexed element is
 *      diffed against its last known values, catching anything the first
 *      two layers can't see.
 *
 * Serialized by Playwright and executed in the page: must be self-contained.
 */
export function installSceneProbe(config) {
  const root = config.root ? document.querySelector(config.root) : document.body;
  if (!root) throw new Error(`viderstand: no element matches root "${config.root}"`);

  const SWEEP_EVERY = config.sweepEvery ?? 5;
  const HOT_MS = 400;
  const MAX_ELEMENTS = config.maxElements ?? 600;
  const warnings = [];

  function cssPath(el) {
    if (el.id) return `#${el.id}`;
    const parts = [];
    let cur = el;
    while (cur && cur !== root && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      const cls = [...cur.classList].slice(0, 2).join('.');
      if (cls) part += `.${cls}`;
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function parseMatrix(str) {
    const out = { tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotate: 0 };
    if (!str || str === 'none') return out;
    const m = str.match(/matrix(3d)?\(([^)]+)\)/);
    if (!m) return out;
    const v = m[2].split(',').map(Number);
    let a, b, c, d, e, f;
    if (m[1]) {
      a = v[0]; b = v[1]; c = v[4]; d = v[5]; e = v[12]; f = v[13];
    } else {
      [a, b, c, d, e, f] = v;
    }
    out.tx = e;
    out.ty = f;
    out.scaleX = Math.hypot(a, b);
    out.scaleY = Math.hypot(c, d);
    out.rotate = (Math.atan2(b, a) * 180) / Math.PI;
    return out;
  }

  function parseColor(str) {
    const m = str && str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const v = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return [v[0] || 0, v[1] || 0, v[2] || 0, v.length > 3 ? v[3] : 1];
  }

  function readSample(el, now) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const m = parseMatrix(cs.transform);
    return {
      t: now,
      x: r.x, y: r.y, w: r.width, h: r.height,
      opacity: parseFloat(cs.opacity),
      tx: m.tx, ty: m.ty, scaleX: m.scaleX, scaleY: m.scaleY, rotate: m.rotate,
      radius: parseFloat(cs.borderRadius) || 0,
      bg: parseColor(cs.backgroundColor),
      fg: parseColor(cs.color),
    };
  }

  function colorChanged(a, b) {
    if (!a || !b) return a !== b;
    return (
      Math.abs(a[0] - b[0]) > 1 || Math.abs(a[1] - b[1]) > 1 ||
      Math.abs(a[2] - b[2]) > 1 || Math.abs(a[3] - b[3]) > 0.01
    );
  }

  function sampleChanged(prev, cur) {
    if (!prev) return false;
    return (
      Math.abs(prev.x - cur.x) > 0.1 || Math.abs(prev.y - cur.y) > 0.1 ||
      Math.abs(prev.w - cur.w) > 0.1 || Math.abs(prev.h - cur.h) > 0.1 ||
      Math.abs(prev.tx - cur.tx) > 0.1 || Math.abs(prev.ty - cur.ty) > 0.1 ||
      Math.abs(prev.opacity - cur.opacity) > 0.002 ||
      Math.abs(prev.scaleX - cur.scaleX) > 0.001 ||
      Math.abs(prev.scaleY - cur.scaleY) > 0.001 ||
      Math.abs(prev.rotate - cur.rotate) > 0.05 ||
      Math.abs(prev.radius - cur.radius) > 0.1 ||
      colorChanged(prev.bg, cur.bg) || colorChanged(prev.fg, cur.fg)
    );
  }

  // ---- element index ----
  const tracked = new Map(); // Element -> {key, last, lastPushed, frames, hotUntil}
  let capped = false;

  function indexElement(el) {
    if (tracked.has(el)) return tracked.get(el);
    if (tracked.size >= MAX_ELEMENTS) {
      if (!capped) {
        capped = true;
        warnings.push(`element cap ${MAX_ELEMENTS} reached; some elements are not observed`);
      }
      return null;
    }
    const entry = { key: cssPath(el), last: null, lastPushed: null, frames: [], hotUntil: 0 };
    tracked.set(el, entry);
    return entry;
  }

  for (const el of [root, ...root.querySelectorAll('*')]) indexElement(el);

  function markHot(el, now) {
    const entry = indexElement(el);
    if (entry) entry.hotUntil = Math.max(entry.hotUntil, now + HOT_MS);
  }

  // Layer 1: mutations. A class/style change on a parent can restyle its
  // descendants without mutating them, so heat the subtree (bounded).
  function markSubtreeHot(el, now) {
    if (el.nodeType !== 1) return;
    markHot(el, now);
    const kids = el.querySelectorAll('*');
    for (let i = 0; i < Math.min(kids.length, 200); i++) markHot(kids[i], now);
  }
  const mo = new MutationObserver((records) => {
    const now = performance.now();
    for (const rec of records) {
      if (rec.type === 'childList') {
        for (const n of rec.addedNodes) markSubtreeHot(n, now);
        if (rec.target.nodeType === 1) markHot(rec.target, now);
      } else {
        markSubtreeHot(rec.target, now);
      }
    }
  });
  mo.observe(root, { subtree: true, childList: true, attributes: true });

  const state = { running: true, lastChangeT: performance.now(), frameIdx: 0 };
  const ticks = [];

  function sampleEntry(el, entry, now) {
    const cur = readSample(el, now);
    const moved = sampleChanged(entry.last, cur);
    if (moved) {
      state.lastChangeT = now;
      entry.hotUntil = Math.max(entry.hotUntil, now + HOT_MS);
      // Push the pre-motion anchor frame if the sweep had been skipping it.
      if (entry.last && entry.lastPushed !== entry.last) entry.frames.push(entry.last);
      entry.frames.push(cur);
      entry.lastPushed = cur;
    } else if (entry.hotUntil > now || entry.frames.length === 0) {
      entry.frames.push(cur);
      entry.lastPushed = cur;
    }
    entry.last = cur;
  }

  function tick(now) {
    ticks.push(now);
    state.frameIdx++;

    // Layer 2: animations starting anywhere heat their targets.
    try {
      for (const a of document.getAnimations({ subtree: true })) {
        const target = a.effect && a.effect.target;
        if (target && root.contains(target)) markHot(target, now);
      }
    } catch { /* getAnimations can throw during teardown */ }

    const sweep = state.frameIdx % SWEEP_EVERY === 0;
    for (const [el, entry] of tracked) {
      if (!el.isConnected) continue;
      if (sweep || entry.hotUntil > now || entry.frames.length === 0) {
        sampleEntry(el, entry, now);
      }
    }
    if (state.running) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__viderstand = {
    config,
    status() {
      return { lastChangeT: state.lastChangeT, now: performance.now(), trackedCount: tracked.size };
    },
    stop() {
      state.running = false;
      mo.disconnect();
      const elements = [];
      for (const entry of tracked.values()) {
        if (entry.frames.length >= 5) elements.push({ key: entry.key, frames: entry.frames });
      }
      return { elements, ticks, warnings };
    },
  };
  return true;
}
