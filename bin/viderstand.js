#!/usr/bin/env node
/**
 * CLI: viderstand <url-or-file> --selector <css> [--trigger click:#btn] ...
 */
import { writeFileSync } from 'node:fs';
import { measure } from '../src/index.js';
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
  viderstand <url-or-file> --selector <css> [options]

Options:
  --selector <css>      Element to observe (required)
  --trigger <spec>      click:<sel> | hover:<sel> | focus:<sel> | js:<expr> | none
                        (default: none — records whatever is already animating)
  --max-duration <ms>   Recording cap, default 4000
  --idle <ms>           Stop after this much stillness, default 600
  --props <a,b>         Extra numeric CSS properties to sample (e.g. border-radius)
  --json [file]         Emit JSON report (to stdout with --json, or to a file)
  --points              Include raw progress points in JSON output
  --no-plot             Skip the ASCII curve plot

Examples:
  viderstand examples/fixture.html --selector '#box' --trigger 'click:#slide'
  viderstand http://localhost:3000 --selector '.modal' --trigger 'click:#open' --json report.json
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args._[0];
  if (!url || args.help) {
    console.log(HELP);
    process.exit(url ? 0 : 1);
  }
  if (!args.selector) {
    console.error('error: --selector is required\n');
    console.log(HELP);
    process.exit(1);
  }

  const { analysis, report } = await measure({
    url,
    selector: args.selector,
    trigger: args.trigger ?? 'none',
    maxDuration: args['max-duration'] ? Number(args['max-duration']) : undefined,
    idleMs: args.idle ? Number(args.idle) : undefined,
    properties: args.props ? args.props.split(',').map((s) => s.trim()) : [],
  });

  if (args.json) {
    const json = JSON.stringify(toJSON(analysis, { includePoints: !!args.points }), null, 2);
    if (typeof args.json === 'string') {
      writeFileSync(args.json, json);
      console.error(`json written to ${args.json}`);
      console.log(report);
    } else {
      console.log(json);
    }
  } else {
    console.log(report);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
