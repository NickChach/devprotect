import { spawn } from 'node:child_process';
import { RuntimeBroker } from './broker.js';
import type { RuntimeResult } from './types.js';

const MAX_FRAME = 64 * 1024;
export interface ExecutionOptions {
  binary: string;
  source: string;
  broker: RuntimeBroker;
  timeoutMs?: number;
  cwd?: string;
  signal?: AbortSignal;
}

/** Internal development API for trusted synthetic inputs until OS containment exists. */
export function executeJavaScript({ binary, source, broker, timeoutMs = 5000, cwd, signal }: ExecutionOptions): Promise<RuntimeResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid runtime timeout');
  const start = broker.snapshot();
  return new Promise(resolve => {
    const child = spawn(binary, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0);
    let outputBytes = 0;
    let stderr = '';
    let pending = false;
    let done = false;
    let failure: { status: RuntimeResult['status']; error: string } | undefined;
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (status: RuntimeResult['status'], error: string) => {
      if (settled || failure) return;
      failure = { status, error: error.slice(0, 1000) };
      broker.addGap('execution', error.slice(0, 1000));
      broker.close();
      cleanup();
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('timed-out', 'Runtime deadline exceeded'), timeoutMs);
    const abort = () => fail('cancelled', 'Runtime cancelled');
    child.on('error', error => fail('unavailable', error.message));
    child.stdin.on('error', error => fail('protocol-error', error.message));
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) + chunk.length > MAX_FRAME) fail('protocol-error', 'Runtime stderr limit exceeded');
      else stderr += chunk.toString('utf8');
    });
    child.on('close', code => {
      if (settled) return;
      if (!failure && (code !== 0 || !done || pending || buffer.length)) fail('protocol-error', `Runtime failed (${code}): ${stderr.slice(0, 500)}`);
      settled = true;
      cleanup();
      const snapshot = broker.snapshot();
      resolve({ status: failure?.status ?? 'completed', ...(failure ? { error: failure.error } : {}), events: snapshot.events.slice(start.events.length), coverage: { status: 'incomplete', gaps: snapshot.gaps.slice(start.gaps.length) } });
    });
    const send = (value: unknown) => {
      const frame = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('Outgoing frame limit exceeded');
      child.stdin.write(frame);
    };
    const handle = async (frame: Buffer) => {
      const message: unknown = JSON.parse(frame.toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid protocol message');
      const data = message as Record<string, unknown>;
      if (done || pending) throw new Error('Invalid runtime protocol sequence');
      if (data.type === 'done') {
        done = true;
        if (data.success !== true) { fail('failed', `JavaScript execution failed: ${String(data.error).slice(0, 500)}`); return; }
        child.stdin.end();
        return;
      }
      if (data.type !== 'request') throw new Error('Invalid runtime request');
      pending = true;
      const response = await broker.request(data.request, cwd);
      if (failure || settled) return;
      send(response);
      pending = false;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || failure) return;
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) { fail('protocol-error', 'Runtime output limit exceeded'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      let index: number;
      while (!failure && (index = buffer.indexOf(10)) !== -1) {
        if (index + 1 > MAX_FRAME) { fail('protocol-error', 'Incoming frame limit exceeded'); return; }
        const frame = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        void handle(frame).catch(error => fail('protocol-error', String(error)));
      }
      if (buffer.length >= MAX_FRAME) fail('protocol-error', 'Incoming frame limit exceeded');
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { send({ type: 'execute', version: 1, source }); }
    catch (error) { fail('protocol-error', String(error)); }
  });
}
