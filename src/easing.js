/**
 * Easing math: evaluate CSS cubic-bezier curves, fit a bezier to observed
 * progress samples, classify against named easings, detect spring behavior.
 *
 * A CSS cubic-bezier(x1, y1, x2, y2) is parametric: x(s) and y(s) for s in
 * [0,1], where x is normalized time and y is normalized progress. To get
 * progress at time u we solve x(s) = u for s, then evaluate y(s).
 */

export const NAMED_EASINGS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  // Common design-system curves worth recognizing by name.
  'material-standard': [0.4, 0, 0.2, 1],
  'material-decelerate': [0, 0, 0.2, 1],
  'material-accelerate': [0.4, 0, 1, 1],
  'quart-out': [0.25, 1, 0.5, 1],
  'expo-out': [0.16, 1, 0.3, 1],
  'back-out': [0.34, 1.56, 0.64, 1],
};

function bezierAxis(t, p1, p2) {
  // Cubic bezier with P0=0, P3=1 on one axis.
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

function bezierAxisDerivative(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * Returns f(u): normalized time -> normalized progress for
 * cubic-bezier(x1, y1, x2, y2).
 */
export function cubicBezier(x1, y1, x2, y2) {
  return function ease(u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    // Solve x(s) = u with Newton's method, bisection fallback.
    let s = u;
    for (let i = 0; i < 8; i++) {
      const x = bezierAxis(s, x1, x2) - u;
      if (Math.abs(x) < 1e-6) return bezierAxis(s, y1, y2);
      const d = bezierAxisDerivative(s, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      s -= x / d;
      if (s < 0) s = 0;
      if (s > 1) s = 1;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      s = (lo + hi) / 2;
      if (bezierAxis(s, x1, x2) < u) lo = s;
      else hi = s;
    }
    return bezierAxis(s, y1, y2);
  };
}

/**
 * RMSE between observed progress points and a bezier curve.
 * points: [{ u, p }] with u, p normalized (p may exceed [0,1] for springs).
 */
export function easingRmse(points, params) {
  const f = cubicBezier(...params);
  let sum = 0;
  for (const { u, p } of points) {
    const e = f(u) - p;
    sum += e * e;
  }
  return Math.sqrt(sum / points.length);
}

/**
 * Generic Nelder-Mead minimizer, enough for 4-parameter bezier fitting.
 */
export function nelderMead(f, x0, { maxIter = 300, step = 0.15, tol = 1e-7 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] += step;
    simplex.push(v);
  }
  let values = simplex.map(f);

  const order = () => {
    const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = idx.map((i) => simplex[i]);
    values = idx.map((i) => values[i]);
  };

  for (let iter = 0; iter < maxIter; iter++) {
    order();
    if (Math.abs(values[n] - values[0]) < tol) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    }
    const worst = simplex[n];
    const reflected = centroid.map((c, j) => c + (c - worst[j]));
    const fr = f(reflected);

    if (fr < values[0]) {
      const expanded = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = f(expanded);
      if (fe < fr) {
        simplex[n] = expanded;
        values[n] = fe;
      } else {
        simplex[n] = reflected;
        values[n] = fr;
      }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflected;
      values[n] = fr;
    } else {
      const contracted = centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = f(contracted);
      if (fc < values[n]) {
        simplex[n] = contracted;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  order();
  return { x: simplex[0], fx: values[0] };
}

function clampParams([x1, y1, x2, y2]) {
  // CSS constrains x to [0,1]; y may overshoot but keep it sane.
  return [
    Math.min(1, Math.max(0, x1)),
    Math.min(2, Math.max(-1, y1)),
    Math.min(1, Math.max(0, x2)),
    Math.min(2, Math.max(-1, y2)),
  ];
}

/**
 * Fit a free cubic-bezier to observed progress points. Multi-starts from
 * every named easing so the optimizer never sinks into a bad local minimum.
 */
export function fitCubicBezier(points) {
  const objective = (params) => easingRmse(points, clampParams(params));
  let best = null;
  for (const start of Object.values(NAMED_EASINGS)) {
    const result = nelderMead(objective, start.slice());
    if (!best || result.fx < best.fx) best = result;
  }
  const params = clampParams(best.x).map((v) => Math.round(v * 1000) / 1000);
  return { params, rmse: easingRmse(points, params) };
}

/**
 * Classify observed progress points: closest named easing plus a free fit.
 *
 * Returns:
 *   { name, namedRmse, namedParams, fitted: { params, rmse }, confident }
 *
 * `confident` is true when the named curve explains the data nearly as well
 * as the free fit — i.e. the animation really is that named easing.
 */
export function classifyEasing(points) {
  let bestName = null;
  let bestRmse = Infinity;
  for (const [name, params] of Object.entries(NAMED_EASINGS)) {
    const rmse = easingRmse(points, params);
    if (rmse < bestRmse) {
      bestRmse = rmse;
      bestName = name;
    }
  }
  const fitted = fitCubicBezier(points);
  const confident = bestRmse < 0.02 && bestRmse < fitted.rmse + 0.015;
  return {
    name: bestName,
    namedRmse: Math.round(bestRmse * 1e4) / 1e4,
    namedParams: NAMED_EASINGS[bestName],
    fitted: { params: fitted.params, rmse: Math.round(fitted.rmse * 1e4) / 1e4 },
    confident,
  };
}

/**
 * Detect spring/overshoot behavior in a progress series.
 * points: [{ u, p }] normalized so p=1 is the settled end value.
 */
export function analyzeSpring(points) {
  let maxP = -Infinity;
  for (const { p } of points) maxP = Math.max(maxP, p);
  const overshoot = maxP - 1;
  if (overshoot < 0.02) return { isSpring: false };

  // Count oscillations: local extrema outside the +/-2% settle band.
  let extrema = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1].p;
    const cur = points[i].p;
    const next = points[i + 1].p;
    const isPeak = cur > prev && cur > next;
    const isTrough = cur < prev && cur < next;
    if ((isPeak || isTrough) && Math.abs(cur - 1) > 0.02) extrema++;
  }

  // Settle time: last moment the curve is outside the 2% band.
  let settleU = 0;
  for (const { u, p } of points) {
    if (Math.abs(p - 1) > 0.02) settleU = u;
  }

  return {
    isSpring: true,
    overshootRatio: Math.round(overshoot * 1000) / 1000,
    oscillations: extrema,
    settleU: Math.round(settleU * 1000) / 1000,
  };
}
