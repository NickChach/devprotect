import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeSource, inspectText } from './analyze.js';
import type { ScanReport } from './model.js';

export const LIMITS = { entries: 10_000, fileBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024, depth: 32 } as const;

async function readBounded(path: string): Promise<Buffer> {
  // Do not follow file symlinks or block on FIFOs during inventory.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file');
    if (stat.size > LIMITS.fileBytes) throw new Error('File exceeds size limit');
    const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMITS.fileBytes) throw new Error('File exceeds size limit');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function scanDirectory(input: string): Promise<ScanReport> {
  const target = await realpath(input);
  if (!(await lstat(target)).isDirectory()) throw new Error('Target must be a package directory');
  const manifestBytes = await readBounded(join(target, 'package.json'));
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('package.json must contain an object');
  const pkg = manifest as Record<string, unknown>;
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new Error('package.json requires string name and version fields');
  const report: ScanReport = {
    schemaVersion: 1, target,
    package: { name: pkg.name, version: pkg.version, source: 'local-directory' },
    files: [], scripts: [], findings: [],
    coverage: { status: 'incomplete', gaps: [
      { stage: 'static', reason: 'Only JavaScript/TypeScript sources and manifest commands are analyzed, using literal-reference rules; other file contents, computed values, and data flow are not analyzed.' },
      { stage: 'dependencies', reason: 'Dependency resolution and transitive package scanning are not implemented.' },
      { stage: 'simulation', reason: 'Package code and lifecycle scripts were not executed. Runtime simulation is not implemented for scan targets.' },
      { stage: 'advisories', reason: 'Known vulnerability advisories were not queried.' },
    ] },
  };
  if (pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) throw new Error('package.json scripts must contain an object');
  if (pkg.scripts) {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      if (typeof command !== 'string') throw new Error(`Invalid script command: ${name}`);
      report.scripts.push({ name, command, status: 'not-run' });
      report.findings.push(...inspectText('package.json', command));
    }
  }
  const gap = (file: string, reason: string) => report.coverage.gaps.push({ stage: 'inventory', file, reason });
  const pending = [{ relative: '', depth: 0 }];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    let children;
    try { children = await readdir(join(target, current.relative), { withFileTypes: true }); }
    catch { gap(current.relative || '.', 'Directory could not be read'); continue; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (++entries > LIMITS.entries) { gap('.', 'Inventory entry limit reached'); pending.length = 0; break; }
      const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
      if (child.isSymbolicLink()) { gap(relative, 'Symbolic link skipped'); continue; }
      if (child.isDirectory()) {
        if (['node_modules', '.git'].includes(child.name)) gap(relative, 'Excluded directory');
        else if (current.depth >= LIMITS.depth) gap(relative, 'Directory depth limit reached');
        else pending.push({ relative, depth: current.depth + 1 });
        continue;
      }
      if (!child.isFile()) { gap(relative, 'Non-regular file skipped'); continue; }
      let content: Buffer;
      try { content = relative === 'package.json' ? manifestBytes : await readBounded(join(target, relative)); }
      catch { gap(relative, 'File unreadable, changed type, or exceeds size limit'); continue; }
      bytes += content.length;
      if (bytes > LIMITS.totalBytes) { gap('.', 'Total byte limit reached'); pending.length = 0; break; }
      report.files.push({ path: relative, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      if (/\.[cm]?[jt]sx?$/.test(relative)) {
        try { report.findings.push(...analyzeSource(relative, content.toString('utf8'))); }
        catch { report.coverage.gaps.push({ stage: 'static', file: relative, reason: 'Source could not be parsed; static analysis incomplete for this file' }); }
      }
      if (/\.(?:node|exe|dll|so|dylib|wasm)$/i.test(relative)) report.coverage.gaps.push({ stage: 'static', file: relative, reason: 'Native or WebAssembly file inventoried but not analyzed' });
    }
  }
  report.files.sort((a, b) => a.path.localeCompare(b.path));
  return report;
}
