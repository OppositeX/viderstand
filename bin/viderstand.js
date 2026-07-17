#!/usr/bin/env node
/**
 * CLI:
 *   viderstand <url> --selector <css> [options]        single-element mode
 *   viderstand <url> --scene [options]                 auto-discovery mode
 *   viderstand compare <ref-url> <replica-url> [opts]  replication diff
 */
import { writeFileSync } from 'node:fs';
import { measure, measureScene, compare } from '../src/index.js';
import { toJSON } from '../src/report.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `viderstand — measure browser animations as numbers, not pixels

Usage:
  viderstand <url-or-file> --selector <css> [options]   measure one element
  viderstand <url-or-file> --scene [options]            auto-discover everything that animates
  viderstand compare <reference> <replica> [options]    diff a replica against a reference

Options:
  --selector <css>      Element to observe (single-element mode)
  --scene               Observe the whole page; no selector needed
  --root <css>          Scene mode: restrict observation to a subtree
  --trigger <spec>      click:<sel> | hover:<sel> | focus:<sel> | js:<expr> | none
  --trigger-replica <spec>   compare mode: separate trigger for the replica
                             (defaults to --trigger)
  --max-duration <ms>   Recording cap, default 4000
  --idle <ms>           Stop after this much stillness, default 600
  --props <a,b>         Extra numeric CSS properties (single-element mode)
  --json [file]         Emit JSON (to stdout, or to a file)
  --points              Include raw progress points in JSON output
  --no-plot             Skip the ASCII curve plot

Examples:
  viderstand examples/fixture.html --selector '#box' --trigger 'click:#slide'
  viderstand http://localhost:3000 --scene --trigger 'click:#open'
  viderstand compare https://reference.app http://localhost:3000 --trigger 'click:#play'
`;

function commonOptions(args) {
  return {
    trigger: args.trigger ?? 'none',
    maxDuration: args['max-duration'] ? Number(args['max-duration']) : undefined,
    idleMs: args.idle ? Number(args.idle) : undefined,
  };
}

function emit(args, report, json) {
  if (args.json) {
    const text = JSON.stringify(json, null, 2);
    if (typeof args.json === 'string') {
      writeFileSync(args.json, text);
      console.error(`json written to ${args.json}`);
      console.log(report);
    } else {
      console.log(text);
    }
  } else {
    console.log(report);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args._[0] === 'compare') {
    const [, ref, rep] = args._;
    if (!ref || !rep) {
      console.error('error: compare needs a reference and a replica url\n');
      console.log(HELP);
      process.exit(1);
    }
    const common = commonOptions(args);
    const result = await compare(
      { url: ref, root: args.root, ...common },
      { url: rep, root: args.root, ...common, trigger: args['trigger-replica'] ?? common.trigger }
    );
    emit(args, result.report, result.comparison);
    process.exit(result.comparison.score === 1 ? 0 : 2);
  }

  const url = args._[0];
  if (!url || args.help) {
    console.log(HELP);
    process.exit(url ? 0 : 1);
  }

  if (args.scene) {
    const { scene, report } = await measureScene({ url, root: args.root, ...commonOptions(args) });
    emit(args, report, scene);
    return;
  }

  if (!args.selector) {
    console.error('error: --selector is required (or use --scene)\n');
    console.log(HELP);
    process.exit(1);
  }

  const { analysis, report } = await measure({
    url,
    selector: args.selector,
    ...commonOptions(args),
    properties: args.props ? args.props.split(',').map((s) => s.trim()) : [],
  });
  emit(args, report, toJSON(analysis, { includePoints: !!args.points }));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
