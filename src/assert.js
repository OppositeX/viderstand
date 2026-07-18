/**
 * Assertion helpers so animation specs can live in tests:
 *
 *   const seg = firstSegment(analysis, 'tx');
 *   expectAnimation(seg)
 *     .toHaveDuration(300, { tolerance: 30 })
 *     .toMatchEasing('ease-out')
 *     .toTravel(240, { tolerance: 2 });
 */

export class AnimationAssertionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'AnimationAssertionError';
    this.details = details;
  }
}

export function firstSegment(analysis, channel) {
  const ch = analysis.channels[channel];
  if (!ch || ch.segments.length === 0) {
    const available = Object.keys(analysis.channels).join(', ') || 'none';
    throw new AnimationAssertionError(
      `expected "${channel}" to animate, but it did not (animated channels: ${available})`
    );
  }
  return ch.segments[0];
}

export function expectAnimation(segment) {
  const api = {
    toHaveDuration(ms, { tolerance = 25 } = {}) {
      const delta = segment.durationMs - ms;
      if (Math.abs(delta) > tolerance) {
        throw new AnimationAssertionError(
          `duration ${segment.durationMs}ms is not within ±${tolerance}ms of ${ms}ms (off by ${Math.round(delta)}ms)`,
          { measured: segment.durationMs, expected: ms, tolerance }
        );
      }
      return api;
    },

    toMatchEasing(name, { maxRmse = 0.03 } = {}) {
      if (segment.spring?.isSpring) {
        throw new AnimationAssertionError(
          `expected easing "${name}" but motion is spring-like (overshoots by ${Math.round(
            segment.spring.overshootRatio * 100
          )}%)`
        );
      }
      const e = segment.easing;
      if (e.name !== name || e.namedRmse > maxRmse) {
        throw new AnimationAssertionError(
          `expected easing "${name}" but measured curve is closest to "${e.name}" ` +
            `(rmse ${e.namedRmse}); free fit: cubic-bezier(${e.fitted.params.join(', ')})`,
          { expected: name, closest: e.name, rmse: e.namedRmse, fitted: e.fitted }
        );
      }
      return api;
    },

    toTravel(distance, { tolerance = 1 } = {}) {
      const delta = segment.distance - distance;
      if (Math.abs(delta) > tolerance) {
        throw new AnimationAssertionError(
          `travel ${segment.distance} is not within ±${tolerance} of ${distance}`,
          { measured: segment.distance, expected: distance, tolerance }
        );
      }
      return api;
    },

    toBeSpring({ minOvershoot = 0.02 } = {}) {
      if (!segment.spring?.isSpring || segment.spring.overshootRatio < minOvershoot) {
        throw new AnimationAssertionError(
          `expected spring-like motion (overshoot ≥ ${minOvershoot * 100}%) but got ` +
            (segment.spring?.isSpring
              ? `overshoot ${Math.round(segment.spring.overshootRatio * 100)}%`
              : 'a non-overshooting curve')
        );
      }
      return api;
    },
  };
  return api;
}

export function expectFrames(analysis) {
  const stats = analysis.frameStats;
  const api = {
    toHaveNoDroppedFrames({ allow = 0 } = {}) {
      if (stats.droppedFrames > allow) {
        throw new AnimationAssertionError(
          `${stats.droppedFrames} dropped frame(s) (worst ${stats.worstFrameMs}ms), allowed ${allow}`,
          stats
        );
      }
      return api;
    },
    toAverageAtLeast(fps) {
      if (stats.avgFps < fps) {
        throw new AnimationAssertionError(`avg ${stats.avgFps}fps is below required ${fps}fps`, stats);
      }
      return api;
    },
  };
  return api;
}
