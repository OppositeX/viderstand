/**
 * viderstand — measure animations instead of squinting at screenshots.
 *
 *   import { measure } from 'viderstand';
 *   const { analysis, report } = await measure({
 *     url: 'http://localhost:3000',
 *     selector: '.modal',
 *     trigger: 'click:#open',
 *   });
 */
export { record } from './recorder.js';
export { analyze, findSegments, frameStats } from './analyze.js';
export { renderReport, toJSON, sparkline, asciiPlot } from './report.js';
export {
  expectAnimation,
  expectFrames,
  firstSegment,
  AnimationAssertionError,
} from './assert.js';
export {
  cubicBezier,
  classifyEasing,
  fitCubicBezier,
  analyzeSpring,
  NAMED_EASINGS,
} from './easing.js';

import { record } from './recorder.js';
import { analyze } from './analyze.js';
import { renderReport, toJSON } from './report.js';

/**
 * One-shot: record + analyze + render.
 */
export async function measure(options) {
  const recording = await record(options);
  const analysis = analyze(recording);
  return {
    recording,
    analysis,
    report: renderReport(analysis),
    json: toJSON(analysis),
  };
}
