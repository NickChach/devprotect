import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryFs } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { runDemo, runFixture, FIXTURE_PRELUDE } from '../src/runtime/demo.js';
import { executeJavaScript } from '../src/runtime/bridge.js';
import { RuntimeBroker } from '../src/runtime/broker.js';
import { runSyntheticSession } from '../src/runtime/session.js';

const binary = fileURLToPath(new URL('../runtime/target/debug/devprotect-runtime', import.meta.url));
function broker() { return new RuntimeBroker(new InMemoryFs({ '/data/input': 'hello' }), { read: ['/data'], write: ['/data'], network: {} }); }
const source = (body: string) => `${FIXTURE_PRELUDE}\n${body}`;
describe.skipIf(!existsSync(binary))('native fixture integration', () => {
  it('shares shell writes with V8 reads and V8 writes with shell reads', async () => {
    const result = await runDemo();
    expect(result.status).toBe('completed');
    expect(result.credentialObservedInRequest).toBe(true);
    expect(result.shellObservedJavaScriptWrite).toBe(true);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: 'shell', operation: 'file-write', target: '/workspace/input.txt', outcome: 'simulated' }),
      expect.objectContaining({ actor: 'javascript', operation: 'file-read', target: '/workspace/input.txt' }),
      expect.objectContaining({ actor: 'shell', operation: 'file-read', target: '/workspace/result.txt' }),
    ]));
    expect(result.events.map(event => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
  });
  it('supports a second fixture and filesystem operations without special paths', async () => {
    const result = await runFixture('transform');
    expect(result.status).toBe('completed');
    expect(result.events.filter(event => event.actor === 'javascript').map(event => event.operation)).toEqual(expect.arrayContaining(['directory-create', 'file-write', 'file-append', 'file-exists', 'file-stat', 'directory-read']));
  });
  it('preserves events before guest failure', async () => {
    const result = await runFixture('failure');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('synthetic failure');
    expect(result.events).toContainEqual(expect.objectContaining({ actor: 'javascript', operation: 'file-read', outcome: 'simulated' }));
  });
  it('preserves events on a deadline and revokes the broker', async () => {
    const instance = broker();
    const result = await executeJavaScript({ binary, source: source("fs.readFileSync('/data/input'); while(true) {}"), broker: instance, timeoutMs: 250 });
    expect(result.status).toBe('timed-out');
    expect(result.events).toHaveLength(1);
    expect((await instance.request({ operation: 'write', target: '/data/input', body: 'late' })).ok).toBe(false);
    expect(instance.snapshot().events).toEqual(result.events);
  });
  it('preserves events on cancellation', async () => {
    const controller = new AbortController();
    const instance = broker();
    const result = executeJavaScript({ binary, source: source("fs.readFileSync('/data/input'); while(true) {}"), broker: instance, signal: controller.signal });
    // Abort once the capability event has arrived, rather than relying on startup timing.
    const timer = setInterval(() => { if (instance.snapshot().events.length) controller.abort(); }, 10);
    try { const completed = await result; expect(completed.status).toBe('cancelled'); expect(completed.events).toHaveLength(1); }
    finally { clearInterval(timer); }
  });
  it('retains coverage gaps when the guest catches denied and unsupported operations', async () => {
    const result = await runFixture('denied');
    expect(result.status).toBe('completed');
    expect(result.events.map(event => event.outcome)).toEqual(expect.arrayContaining(['denied', 'unsupported']));
    expect(result.coverage.gaps.map(gap => gap.kind)).toEqual(expect.arrayContaining(['denied', 'unsupported']));
  });
  it('returns a structured protocol failure for oversized source', async () => {
    const result = await executeJavaScript({ binary, source: 'x'.repeat(70_000), broker: broker() });
    expect(result.status).toBe('protocol-error');
    expect(result.error).toContain('frame limit');
  });
  it('handles an already-cancelled execution', async () => {
    const result = await executeJavaScript({ binary, source: '', broker: broker(), signal: AbortSignal.abort() });
    expect(result.status).toBe('cancelled');
  });
  it('waits for native cleanup at the session deadline and returns stable history', async () => {
    const memory = new InMemoryFs({ '/work/script.js': source("fs.readFileSync('/work/input'); while(true) {}"), '/work/input': 'synthetic' });
    const result = await runSyntheticSession({ binary, fs: memory, cwd: '/work', policy: { read: ['/work', '/usr/bin', '/bin'], write: ['/work'], network: {} }, shell: 'node script.js', timeoutMs: 250 });
    expect(result.status).toBe('timed-out');
    expect(result.events).toContainEqual(expect.objectContaining({ actor: 'javascript', operation: 'file-read', outcome: 'simulated' }));
    expect(result.executions).toHaveLength(1);
    expect(['cancelled', 'timed-out']).toContain(result.executions[0]?.status);
  });
  it('uses the invoking command cwd and arbitrary caller paths and responses', async () => {
    const memory = new InMemoryFs({ '/alternate/child/script.js': source("const v = fs.readFileSync('input'); const response = call('network', 'https://another.invalid', v); fs.writeFileSync('output', response.body);"), '/alternate/child/input': 'different' });
    const result = await runSyntheticSession({ binary, fs: memory, cwd: '/alternate', policy: { read: ['/alternate', '/usr/bin', '/bin'], write: ['/alternate'], network: { 'https://another.invalid': { status: 202, body: 'configured' } } }, shell: 'cd child && node script.js' });
    expect(result.status).toBe('completed');
    expect(await memory.readFile('/alternate/child/output')).toBe('configured');
    expect(result.events).toContainEqual(expect.objectContaining({ operation: 'network-attempt', target: 'https://another.invalid', body: 'different' }));
  });
  it('retains shell failure and its prior events', async () => {
    const result = await runSyntheticSession({ binary, fs: new InMemoryFs(), cwd: '/work', policy: { read: ['/work', '/usr/bin', '/bin'], write: ['/work'], network: {} }, shell: "echo hello > /work/result; false" });
    expect(result.status).toBe('failed');
    expect(result.events).toContainEqual(expect.objectContaining({ actor: 'shell', operation: 'file-write', outcome: 'simulated' }));
  });
});
it('reports a missing runtime binary as a structured result', async () => {
  expect((await executeJavaScript({ binary: '/nonexistent/devprotect-runtime', source: '', broker: broker() })).status).toBe('unavailable');
});
