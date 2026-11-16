#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { scanDirectory } from './scan.js';
import { renderReport, safeText } from './report.js';

const HELP = `DevProtect — initial implementation

Usage:
  devprotect scan <package-directory> [--json]
  devprotect runtime-demo [--json]

scan performs local static inspection only. Coverage is always incomplete.
runtime-demo runs only the built-in synthetic fixture; it does not accept package code.
Exit codes: 0 report produced, 1 operation failed, 2 invalid arguments.
`;

async function main(): Promise<void> {
  let args;
  try { args = parseArgs({ options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true }); }
  catch (error) { console.error(safeText(String(error))); process.exitCode = 2; return; }
  const [command, target] = args.positionals;
  if (args.values.help || !command) { console.log(HELP); return; }
  if (command === 'scan' && target && args.positionals.length === 2) {
    const report = await scanDirectory(target);
    console.log(args.values.json ? JSON.stringify(report, null, 2) : renderReport(report));
  } else if (command === 'runtime-demo' && args.positionals.length === 1) {
    const { runDemo } = await import('./runtime/demo.js');
    const result = await runDemo();
    console.log(JSON.stringify(result, null, 2));
  } else { console.error(HELP); process.exitCode = 2; }
}

main().catch(error => { console.error(`DevProtect: ${safeText(error instanceof Error ? error.message : String(error))}`); process.exitCode = 1; });
