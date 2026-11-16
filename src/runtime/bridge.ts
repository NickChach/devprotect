import { spawn } from 'node:child_process';
import type { IFileSystem } from 'just-bash';

const MAX_FRAME = 64 * 1024;
export interface RuntimeEvent {
  operation: 'file-read' | 'file-write' | 'network-attempt' | 'unsupported-operation';
  target: string;
  outcome: 'simulated' | 'denied';
  body?: string;
}

// Prototype protocol is strictly sequential: one execution, one pending request,
// one response. Nested execution is intentionally absent.
export function executeFixture(binary: string, source: string, fs: IFileSystem, timeoutMs = 5000, signal?: AbortSignal): Promise<RuntimeEvent[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    const events: RuntimeEvent[] = [];
    let buffer = Buffer.alloc(0);
    let outputBytes = 0;
    let stderr = '';
    let pending = false;
    let done = false;
    let settled = false;
    const timer = setTimeout(() => fail(new Error('Runtime deadline exceeded')), timeoutMs);
    const abort = () => fail(new Error('Runtime cancelled'));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      reject(error);
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_FRAME) fail(new Error('Runtime stderr limit exceeded'));
      else stderr += chunk.toString('utf8');
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0 || !done || pending || buffer.length) reject(new Error(`Runtime failed (${code}): ${stderr.slice(0, 500)}`));
      else resolve(events);
    });
    const send = (value: unknown) => {
      const frame = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('Outgoing frame limit exceeded');
      child.stdin.write(frame);
    };
    const handle = async (frame: Buffer) => {
      const message = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
      if (done || pending) throw new Error('Invalid runtime protocol sequence');
      if (message.type === 'done') {
        if (message.success !== true) throw new Error(`Fixture execution failed: ${String(message.error).slice(0, 500)}`);
        done = true;
        child.stdin.end();
        return;
      }
      if (message.type !== 'request' || !message.request || typeof message.request !== 'object') throw new Error('Invalid runtime request');
      pending = true;
      const request = message.request as Record<string, unknown>;
      if (typeof request.target !== 'string' || request.target.length > 4096) throw new Error('Invalid request target');
      const target = request.target;
      let value: unknown = null;
      // This fixture broker deliberately grants just two virtual paths.
      if (request.operation === 'read' && target === '/home/synthetic/.npmrc') {
        value = await fs.readFile(target);
        events.push({ operation: 'file-read', target, outcome: 'simulated' });
      } else if (request.operation === 'write' && target === '/fixture/result.txt' && typeof request.body === 'string') {
        await fs.writeFile(target, request.body);
        events.push({ operation: 'file-write', target, outcome: 'simulated' });
      } else if (request.operation === 'network' && target === 'https://collector.invalid/collect' && typeof request.body === 'string') {
        events.push({ operation: 'network-attempt', target, body: request.body, outcome: 'simulated' });
        value = { status: 204, simulated: true };
      } else {
        events.push({ operation: 'unsupported-operation', target, outcome: 'denied' });
        send({ type: 'response', ok: false, error: 'Unsupported operation or capability denied' });
        pending = false;
        return;
      }
      send({ type: 'response', ok: true, value });
      pending = false;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) { fail(new Error('Runtime output limit exceeded')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let index: number;
      while ((index = buffer.indexOf(10)) !== -1) {
        if (index + 1 > MAX_FRAME) { fail(new Error('Incoming frame limit exceeded')); return; }
        const frame = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        void handle(frame).catch(error => fail(error instanceof Error ? error : new Error(String(error))));
      }
      if (buffer.length >= MAX_FRAME) fail(new Error('Incoming frame limit exceeded'));
    });
    try { send({ type: 'execute', version: 1, source }); }
    catch (error) { fail(error as Error); }
  });
}
