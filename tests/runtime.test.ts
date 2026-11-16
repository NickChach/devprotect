import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryFs } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { runDemo } from '../src/runtime/demo.js';
import { executeFixture } from '../src/runtime/bridge.js';

const binary = fileURLToPath(new URL('../runtime/target/debug/devprotect-runtime', import.meta.url));
describe.skipIf(!existsSync(binary))('native fixture integration (requires npm run runtime:build)', () => {
  it('shares shell writes with synchronous V8 reads and V8 writes with shell reads', async () => {
    const result = await runDemo();
    expect(result.credentialObservedInRequest).toBe(true);
    expect(result.shellObservedJavaScriptWrite).toBe(true);
    expect(result.events.map(event => event.operation)).toEqual(['file-read', 'network-attempt', 'file-write']);
  });
  it('terminates an infinite JavaScript loop using the process deadline', async () => {
    await expect(executeFixture(binary, 'while(true) {}', new InMemoryFs(), 200)).rejects.toThrow('deadline');
  });
  it('reports guest exceptions instead of successful execution', async () => {
    await expect(executeFixture(binary, 'throw new Error("fixture error")', new InMemoryFs())).rejects.toThrow('fixture error');
  });
  it('cancels a running worker', async () => {
    const controller = new AbortController();
    const result = executeFixture(binary, 'while(true) {}', new InMemoryFs(), 5000, controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try { await expect(result).rejects.toThrow('cancelled'); }
    finally { clearTimeout(timer); }
  });
  it('rejects oversized outgoing frames', async () => {
    await expect(executeFixture(binary, 'x'.repeat(70_000), new InMemoryFs())).rejects.toThrow('frame limit');
  });
  it('denies access outside the virtual capability set', async () => {
    const source = `const r = JSON.parse(__hostCall(JSON.stringify({operation:'read',target:'/etc/passwd'}))); if(r.ok) throw new Error('unexpected access');`;
    const events = await executeFixture(binary, source, new InMemoryFs());
    expect(events).toEqual([{ operation: 'unsupported-operation', target: '/etc/passwd', outcome: 'denied' }]);
  });
});

it('reports a missing runtime binary', async () => {
  await expect(executeFixture('/nonexistent/devprotect-runtime', '', new InMemoryFs())).rejects.toThrow();
});
