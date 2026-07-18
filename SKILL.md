---
name: viderstand
description: Measure browser animations as numbers instead of guessing from screenshots — duration, easing curves, spring physics, dropped frames, and where/what moved. Use when building, tuning, verifying, or replicating any web animation or transition; when asked "does it feel right / match the design"; when checking animation speed, easing, smoothness, or jank; or when comparing an animation replica against a reference site. Screenshots cannot measure motion — this skill can.
---

# viderstand — measure animation, don't squint at it

A screenshot is one frame; motion is a function of time. This skill records
real per-frame data from Chromium and turns animation quality into numbers
and verdicts you can act on: exact durations, recovered easing curves
(`cubic-bezier` + closest named easing), spring overshoot, real fps and
dropped frames, and pixel-level "what moved where" — plus a filmstrip image
you can literally look at.

## One-time setup

Run inside this skill's directory:

```sh
npm install --omit=dev
```

A Chromium is auto-detected from (in order): `VIDERSTAND_CHROMIUM` env var,
the Claude Code cloud sandbox (`/opt/pw-browsers/chromium`), any
Playwright-managed browser cache, or a system Chrome/Chromium. If none is
found, run `npx playwright install chromium` once or set
`VIDERSTAND_CHROMIUM=/path/to/chrome`.

All commands below are `node <this-skill-dir>/bin/viderstand.js …` — use the
absolute path to this skill's directory.

## Pick the right mode

| Task | Command |
| --- | --- |
| Tune/verify one element you can name | `viderstand <url> --selector '.modal' --trigger 'click:#open'` |
| Discover everything that animates (no selector needed) | `viderstand <url> --scene --trigger 'click:#open'` |
| SEE the animation as a timestamped filmstrip + pixel metrics | `viderstand film <url> --trigger 'click:#open' --out ./film` |
| Verify a replica against a reference (same-ish markup) | `viderstand compare <refUrl> <replicaUrl> --trigger 'click:#play'` |
| Verify a replica visually — different markup, no IDs needed | `viderstand compare <refUrl> <replicaUrl> --visual --trigger 'click:#play'` |

`<url>` may be an `http(s)://` URL or a local HTML file path. Triggers:
`click:<sel>`, `hover:<sel>`, `focus:<sel>`, `js:<expression>`, or `none`
(records whatever is already animating). Add `--json` for machine-readable
output; `compare` exits 2 on mismatch, so it works as a CI gate.

## Reading the output

```
tx: 0px → 240px (240px) in 400ms, starting at t+166.7ms
  easing ≈ ease-in-out (rmse 0.0001); free fit cubic-bezier(0.42, 0, 0.58, 1)
  declared: 400ms / ease-in-out — measured matches declared timing
frames: 60fps avg — smooth
```

- `easing ≈ <name>` with rmse below ~0.03 means it really is that curve; a
  "no clean named match" line gives you the measured `cubic-bezier(…)` to
  compare against the design spec directly.
- `spring-like: overshoots by N%` replaces easing when motion bounces.
- `DRIFTS +Nms from declared` means the CSS says one duration but the pixels
  did another — a delay, an overriding rule, or a wrong property.
- Dropped frames / worst frame time expose jank no screenshot can show.
- Film reports end with a **motion signature** (a sparkline of change-per-frame)
  and a **motion timeline** (per-frame `ms  Δpixels  center`), and every JSON
  segment carries `frameData` (per-frame timestamps + values). Use these to
  notice similar movements: two motions with the same signature/frame profile
  are the same movement even at different durations, and a divergence's first
  bad frame tells you where in the animation to look.

## The tuning loop

1. Write or edit the CSS/JS animation.
2. Run the matching command above.
3. Read the numbers; fix the specific gap it names (e.g. "closest is linear,
   expected ease-out" → the transition-timing-function isn't applying).
4. Re-run until measured == intended. Never judge motion from a screenshot.

## The replication loop (copying a reference animation)

1. Film the reference once: `viderstand film <refUrl> --trigger … --out ./ref-film`
2. Look at `./ref-film/contact-sheet.png` (open/Read it — it is a grid of
   timestamped frames, the animation laid out for your eyes) and read the
   printed duration/easing/region numbers.
3. Build your replica.
4. `viderstand compare <refUrl> <replicaUrl> --visual --trigger …` — verdicts
   are pixel-only (motion duration, easing curve, screen regions, path), so
   mismatched markup/IDs don't matter.
5. Fix what it flags, re-run until the score is 100%. If identities happen to
   line up, plain `compare` (DOM mode) adds sharper per-element detail.

## Programmatic use (tests)

```js
import { record, analyze, firstSegment, expectAnimation, expectFrames } from '<this-skill-dir>/src/index.js';

const analysis = analyze(await record({ url, selector: '.modal', trigger: 'click:#open' }));
expectAnimation(firstSegment(analysis, 'ty'))
  .toHaveDuration(300, { tolerance: 30 })
  .toMatchEasing('ease-out');
expectFrames(analysis).toHaveNoDroppedFrames();
```

Failures explain themselves in measured terms, so paste them into your fix
loop. Full API in README.md next to this file.
