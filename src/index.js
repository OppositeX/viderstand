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
export { record, recordScene, recordFilm } from './recorder.js';
export {
  analyzeFilmPairs,
  compareFilms,
  renderFilmReport,
  renderFilmCompare,
} from './film.js';
export { analyze, findSegments, frameStats } from './analyze.js';
export {
  analyzeScene,
  compareScenes,
  curveDistance,
  renderSceneReport,
  renderCompareReport,
} from './scene.js';
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

import { record, recordScene, recordFilm } from './recorder.js';
import { analyze } from './analyze.js';
import { renderReport, toJSON } from './report.js';
import { analyzeScene, compareScenes, renderSceneReport, renderCompareReport } from './scene.js';
import { compareFilms, renderFilmCompare } from './film.js';

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

/**
 * One-shot scene mode: auto-discover everything that animates.
 */
export async function measureScene(options) {
  const recording = await recordScene(options);
  const scene = analyzeScene(recording);
  return { recording, scene, report: renderSceneReport(scene) };
}

/**
 * One-shot replication check: record reference and replica, diff the traces.
 *
 * @param {object} reference  recordScene() options for the reference page
 * @param {object} replica    recordScene() options for the replica page
 * @param {object} [tolerance]  compareScenes tolerance overrides
 */
export async function compare(reference, replica, tolerance) {
  const refScene = analyzeScene(await recordScene(reference));
  const repScene = analyzeScene(await recordScene(replica));
  const comparison = compareScenes(refScene, repScene, tolerance);
  return {
    reference: refScene,
    replica: repScene,
    comparison,
    report: renderCompareReport(comparison),
  };
}

/**
 * One-shot visual replication check: film both pages via the screencast and
 * compare pure pixel motion — no selectors, no IDs, works across totally
 * different markup. Pass outDir on each side to keep the frames and the
 * contact-sheet filmstrip for viewing.
 */
export async function compareVisual(reference, replica, tolerance) {
  const ref = await recordFilm(reference);
  const rep = await recordFilm(replica);
  const comparison = compareFilms(ref.analysis, rep.analysis, tolerance);
  return {
    reference: ref,
    replica: rep,
    comparison,
    report: renderFilmCompare(comparison, ref.analysis, rep.analysis),
  };
}
