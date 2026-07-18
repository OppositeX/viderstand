/**
 * The in-page probe. This function is serialized by Playwright and executed
 * inside the browser, so it must be fully self-contained (no closures over
 * Node scope). It samples the target element once per animation frame and
 * exposes control functions on window.__viderstand.
 */
export function installProbe(config) {
  const el = document.querySelector(config.selector);
  if (!el) {
    throw new Error(`viderstand: no element matches selector "${config.selector}"`);
  }

  function parseTransform(str) {
    const out = { tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotate: 0 };
    if (!str || str === 'none') return out;
    const m = str.match(/matrix(3d)?\(([^)]+)\)/);
    if (!m) return out;
    const v = m[2].split(',').map(Number);
    let a, b, c, d, e, f;
    if (m[1]) {
      // matrix3d: 4x4 column-major
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

  const samples = [];
  const state = { running: true, lastChangeT: performance.now() };
  const extraProps = config.properties || [];

  function changed(prev, cur) {
    if (!prev) return false;
    return (
      Math.abs(prev.x - cur.x) > 0.1 ||
      Math.abs(prev.y - cur.y) > 0.1 ||
      Math.abs(prev.w - cur.w) > 0.1 ||
      Math.abs(prev.h - cur.h) > 0.1 ||
      Math.abs(prev.tx - cur.tx) > 0.1 ||
      Math.abs(prev.ty - cur.ty) > 0.1 ||
      Math.abs(prev.opacity - cur.opacity) > 0.002 ||
      Math.abs(prev.scaleX - cur.scaleX) > 0.001 ||
      Math.abs(prev.scaleY - cur.scaleY) > 0.001 ||
      Math.abs(prev.rotate - cur.rotate) > 0.05
    );
  }

  function tick(now) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const t = parseTransform(cs.transform);
    const sample = {
      t: now,
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      opacity: parseFloat(cs.opacity),
      tx: t.tx,
      ty: t.ty,
      scaleX: t.scaleX,
      scaleY: t.scaleY,
      rotate: t.rotate,
    };
    for (const prop of extraProps) {
      const raw = cs.getPropertyValue(prop);
      const num = parseFloat(raw);
      sample['css:' + prop] = Number.isNaN(num) ? null : num;
    }
    if (changed(samples[samples.length - 1], sample)) state.lastChangeT = now;
    samples.push(sample);
    if (state.running) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__viderstand = {
    config,
    declared: [],
    captureDeclared() {
      // Snapshot the *declared intent* via the Web Animations API: what the
      // page says the animation should be, to compare with what we measure.
      try {
        const anims = document.getAnimations({ subtree: true }).filter((a) => {
          const target = a.effect && a.effect.target;
          return target && (target === el || el.contains(target) || target.contains(el));
        });
        window.__viderstand.declared = anims.map((a) => {
          const timing = a.effect.getTiming();
          let keyframes = [];
          try {
            keyframes = a.effect.getKeyframes().map((k) => ({
              offset: k.offset,
              easing: k.easing,
              props: Object.keys(k).filter(
                (key) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key)
              ),
            }));
          } catch {
            /* some effects refuse keyframe introspection */
          }
          return {
            type: a.constructor.name,
            duration: timing.duration,
            delay: timing.delay,
            easing: timing.easing,
            iterations: timing.iterations,
            fill: timing.fill,
            playState: a.playState,
            keyframes,
          };
        });
      } catch {
        window.__viderstand.declared = [];
      }
    },
    status() {
      return {
        sampleCount: samples.length,
        lastChangeT: state.lastChangeT,
        now: performance.now(),
      };
    },
    stop() {
      state.running = false;
      return { samples, declared: window.__viderstand.declared };
    },
  };
  return true;
}
