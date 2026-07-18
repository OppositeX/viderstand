# viderstand

**Measure what you cannot see.** Turn browser animations into numbers an AI agent
(or a CI pipeline) can reason about: duration, easing curves, velocity, spring
physics, and dropped frames — instead of squinting at screenshots.

## The problem

AI coding agents get visual feedback through screenshots. A screenshot is a
single frame: it can prove an element *ended up* in the right place, but it can
never tell you that the transition took 900ms instead of 300ms, that the easing
is `linear` when the design called for `ease-out`, or that the browser dropped
half the frames along the way. Motion is a function of time, and a screenshot
integrates time away. Even a video is barely better for an agent — it's a pile
of pixels that still has to be turned back into numbers before any judgment is
possible.

## The idea

Don't watch the animation. **Instrument it.**

The browser already knows, on every single frame, the exact computed value of
every animatable property. viderstand injects a probe that samples the target
element once per `requestAnimationFrame` — transform matrix (decomposed into
translation, scale, rotation), geometry, opacity, plus any CSS property you ask
for. That produces a time series. From the time series, everything a human eye
judges qualitatively becomes a quantity:

| What a human sees | What viderstand measures |
| --- | --- |
| "feels slow" | segment duration in ms, per property |
| "the easing looks wrong" | best-fit `cubic-bezier(x1, y1, x2, y2)` + closest named easing with RMSE |
| "it's bouncy" | overshoot %, oscillation count, settle time |
| "it stutters" | real fps, dropped frames, worst frame time |
| "it moved too far" | travel distance, start/end values |

Two more pieces close the loop:

1. **Declared vs. observed.** The probe also snapshots the Web Animations API
   (`document.getAnimations()`) — what the page *claims* the animation is
   (duration, easing, keyframes). The report compares intent with measurement,
   which catches an entire class of bugs (transition overridden by another
   rule, animation applied to the wrong property, delay eating the duration).
2. **Text-native output.** Reports render curves as sparklines and ASCII plots,
   so a text-only agent can literally see the shape of the motion, and
   `--json` emits the raw measurements for programmatic feedback loops.

The result is a closed loop for AI-driven motion work: the agent writes CSS,
runs `viderstand`, reads *"350ms, closest easing ease-in (rmse 0.19), expected
ease-out"*, fixes the code, and re-measures — no human eyeball required.

## Install

**As an agent skill** (Claude Code, Cursor, and other SKILL.md-aware agents) — one line:

```sh
npx skills add OppositeX/viderstand
```

That installs this repo (it has a root `SKILL.md`) into the agent's skills
directory; the skill file tells the agent how to set up and drive every mode.
Manual equivalent, or for agents without the `skills` CLI:

```sh
git clone https://github.com/OppositeX/viderstand ~/.claude/skills/viderstand && npm install --omit=dev --prefix ~/.claude/skills/viderstand
```

**As a library/CLI:**

```sh
npm install viderstand           # in a project
npx -y github:OppositeX/viderstand --help   # or run straight from git, no install
```

Chromium is auto-detected: `VIDERSTAND_CHROMIUM` env var, the Claude Code
cloud sandbox browser, any Playwright browser cache, or a system
Chrome/Chromium. If none exists, `npx playwright install chromium` once.

## CLI

```sh
viderstand http://localhost:3000 --selector '.modal' --trigger 'click:#open'
viderstand examples/fixture.html --selector '#box' --trigger 'click:#slide' --json report.json
```

Output:

```
viderstand: 76 frames over 1249.9ms, 2 animated properties
frames: 60fps avg (median frame 16.7ms, worst 16.7ms) — smooth

  tx: 0px → 240px (240px) in 400ms, starting at t+166.7ms
    peak velocity: 1029.9px/s
    easing ≈ ease-in-out (rmse 0.0001); free fit cubic-bezier(0.42, 0, 0.58, 1) (rmse 0.0001)
    declared: 400ms / ease-in-out — measured matches declared timing
    progress: ▁▁▁▁▁▁▁▁▁▁▁▁▂▂▂▂▂▂▃▃▃▃▄▄▅▅▅▆▆▆▆▇▇▇▇▇▇███████████
```

Triggers: `click:<sel>`, `hover:<sel>`, `focus:<sel>`, `js:<expression>`, or
`none` to record whatever is already animating.

## API

```js
import { measure } from 'viderstand';

const { analysis, report, json } = await measure({
  url: 'http://localhost:3000',
  selector: '.modal',
  trigger: 'click:#open',   // or async (page) => { ... } with the Playwright page
  maxDuration: 4000,        // recording cap (ms)
  idleMs: 600,              // auto-stop after this much stillness
  properties: ['border-radius'], // extra numeric CSS properties to sample
});

console.log(report); // human/agent-readable text
```

### Animation specs as tests

```js
import { record, analyze, firstSegment, expectAnimation, expectFrames } from 'viderstand';

const analysis = analyze(await record({ url, selector: '.modal', trigger: 'click:#open' }));

expectAnimation(firstSegment(analysis, 'ty'))
  .toHaveDuration(300, { tolerance: 30 })
  .toMatchEasing('ease-out')
  .toTravel(24, { tolerance: 2 });

expectFrames(analysis).toHaveNoDroppedFrames().toAverageAtLeast(55);
```

Failures explain themselves in measured terms:

> `expected easing "ease-out" but measured curve is closest to "linear" (rmse 0.021); free fit: cubic-bezier(0.11, 0.09, 0.9, 0.92)`

### Scene mode: the self-updating observer

Watching one pre-named element with a fixed property list is not enough when
you're **replicating** an animation — you'd miss changes you didn't think to
watch for. Scene mode observes the whole page and discovers what animates by
itself, through three layers:

1. a `MutationObserver` catches class/style/attribute/DOM changes anywhere in
   the subtree (and heats the affected descendants, since a parent's class
   change restyles children without mutating them),
2. `document.getAnimations()` polling catches CSS transitions/animations and
   WAAPI effects the moment they start on any element,
3. a periodic full sweep diffs every element's computed values as a fallback
   for anything the first two layers can't see.

Any element that changes goes "hot" and is sampled every frame until it
settles. Colors and border-radius are tracked alongside transform, geometry,
and opacity — color transitions get the same duration/easing treatment via a
distance-from-initial-color channel.

```sh
viderstand http://localhost:3000 --scene --trigger 'click:#open'
```

```js
const { scene, report } = await measureScene({ url, trigger: 'click:#open' });
// scene.elements['#modal'].channels.ty.segments[0].easing.name === 'ease-out'
```

### Replication diffing: "did I copy it correctly?"

Record the reference, record your replica, and diff the traces. Every animated
element and channel gets a measured verdict — duration drift, easing curve
distance, travel, stagger offsets, missing or extra animations — plus an
overall score. Exit code 2 on mismatch makes it CI-able.

```sh
viderstand compare https://reference.app http://localhost:3000 --trigger 'click:#play'
```

```
replication score: 0% (0/9 animated channels match the reference)
  ✗ #a tx: duration 700ms vs reference 400ms (+300ms)
  ✗ #b opacity: easing "linear" vs reference "ease-out" (curve rmse 0.134)
  ✗ #c: animates in the reference (x, y, w, h, scaleX, scaleY) but not in the replica
```

```js
const { comparison, report } = await compare(
  { url: referenceUrl, trigger: 'click:#play' },
  { url: replicaUrl, trigger: 'click:#play' },
);
comparison.score;           // 0..1
comparison.elements;        // per-element, per-channel verdicts
```

Elements are matched between the two recordings by their discovered key
(`#id` or a short CSS path), and tolerances (duration ms/%, easing curve RMSE,
stagger ms, overshoot) are overridable per call.

### Film mode: it sees for itself (identity-free)

DOM-trace comparison needs matching element identities — and a rebuilt page
never has the same IDs or markup. Film mode drops the DOM entirely: it
records what the compositor actually paints, using the CDP **screencast**
stream (a frame is pushed every time pixels change, with real timestamps —
much denser than polled screenshots, which would miss most of a 300ms
animation). The filmstrip then feeds two consumers:

- **The agent's eyes.** A `contact-sheet.png` — a grid of timestamped frames,
  the animation laid out as a single image a multimodal model can look at.
- **Numbers from pixels.** Frame-to-frame differencing needs no selectors:
  pixels changed per frame ≈ motion speed, so the cumulative curve is the
  scene's easing; changed-pixel centroids trace the motion path; a 12×8
  activity grid records *where* on screen things moved.

```sh
viderstand film http://localhost:3000 --trigger 'click:#open' --out ./film
# → ./film/frame-*.png, ./film/contact-sheet.png, ./film/film.json
```

```
film: 27 frames; motion starts at t+155ms and spans 375ms
scene easing: cubic-bezier(0.348, 0.253, 0.468, 0.818) — closest named ease-out
activity regions: top-left 54%
```

Visual comparison works across completely different markup:

```sh
viderstand compare https://reference.app http://localhost:3000 --visual --trigger 'click:#play'
```

```
visual replication score: 75%
  ✗ motion spans 633ms vs reference 378ms (+255ms)
```

Verdicts cover overall motion duration, the pixel-derived easing curve,
where on screen activity happens (with named regions like `top-left` when
they diverge), and the centroid path shape.

**Choosing a mode:** film mode is the identity-free safety net — it can't be
fooled by renamed markup, but it measures the scene as a whole. DOM scene
mode gives sharper per-element verdicts (it separates two elements animating
in the same screen region) when identities happen to line up. For replication
work, run the visual compare as the source of truth and read the contact
sheets side by side; use scene mode's per-element numbers to debug what the
visual diff flags.

### Bring your own samples

The analysis layer is decoupled from the recorder. If you can produce
`[{ t, someNumber, ... }]` frames from any source — a React Native harness, a
game engine, a canvas app — `analyze({ samples })` gives you the same
segmentation, easing recovery, and frame stats.

## How the measurements work

- **Segmentation** — each property's series is scanned for contiguous runs of
  frame-to-frame change above a per-channel noise floor; brief single-frame
  stalls are merged, real gaps split into separate segments.
- **Easing recovery** — a segment is normalized to (time 0..1, progress 0..1)
  and compared against a table of named curves (CSS's five plus common
  design-system beziers); a free `cubic-bezier` is also fitted with
  Nelder-Mead, multi-started from every named curve. If a named curve explains
  the data about as well as the free fit, it's reported by name with
  confidence; otherwise you get the fitted parameters.
- **Springs** — progress that overshoots 1.0 is analyzed for overshoot ratio,
  oscillation count (extrema outside a 2% settle band), and settle time
  instead of being force-fitted to a bezier.
- **Frame pacing** — `requestAnimationFrame` timestamps are the compositor's
  own record of what it delivered; deltas beyond 1.5× the median frame count
  as dropped.

## Development

```sh
npm test           # unit + real-browser integration tests
npm run test:unit  # synthetic-data tests only, no browser needed
npm run demo       # measure the bundled fixture
```

## Roadmap

- Color-channel interpolation measurement (parse computed colors into Lab)
- Multi-element choreography (stagger timing between siblings)
- Scroll-linked animation support (sample against scroll position, not time)
- CDP `Compositor` counters for jank attribution (main thread vs raster)
