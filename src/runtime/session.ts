import { Bash, defineCommand, type IFileSystem } from 'just-bash';
import { RuntimeBroker } from './broker.js';
import { executeJavaScript } from './bridge.js';
import type { CapabilityPolicy, RuntimeResult } from './types.js';

export interface SessionOptions {
  binary: string;
  fs: IFileSystem;
  policy: CapabilityPolicy;
  shell: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface SessionResult extends RuntimeResult { stdout: string; stderr: string; executions: RuntimeResult[] }

/** All source, shell text, filesystem backends and policies must be trusted fixtures. */
export async function runSyntheticSession(options: SessionOptions): Promise<SessionResult> {
  const { binary, fs, policy, shell, cwd, env = {}, timeoutMs = 5000, signal } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid runtime timeout');
  const broker = new RuntimeBroker(fs, policy, cwd);
  broker.addGap('execution', 'OS containment and Node compatibility are not implemented; synthetic synchronous fixtures only.');
  broker.addGap('unsupported', 'Shell utilities are limited to printf, cat, echo, mkdir, ls, pwd, true, false, builtins and the custom node command; caught shell command failures are not exhaustively classified.');
  const executions: RuntimeResult[] = [];
  const pendingExecutions: Promise<RuntimeResult>[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let status: RuntimeResult['status'] = 'completed';
  let error: string | undefined;
  const node = defineCommand('node', async (args, ctx) => {
    if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
      broker.addGap('unsupported', 'Only node <virtual-script-path> is supported');
      return { stdout: '', stderr: 'Unsupported node invocation', exitCode: 126 };
    }
    const path = fs.resolvePath(ctx.cwd, args[0]);
    const source = await broker.filesystem('loader').readFile(path);
    const executionPromise = executeJavaScript({ binary, source, broker, cwd: ctx.cwd, timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), signal: controller.signal });
    pendingExecutions.push(executionPromise);
    const execution = await executionPromise;
    executions.push(execution);
    return { stdout: '', stderr: execution.error ?? '', exitCode: execution.status === 'completed' ? 0 : 1 };
  });
  try {
    const guarded = broker.filesystem('shell');
    let preparing = true;
    // just-bash initializes virtual command stubs synchronously. Bootstrap is
    // trusted setup; guest execution only sees the guarded IFileSystem surface.
    const shellFs = new Proxy(fs, { get(target, property) {
      if (!preparing) return Reflect.get(guarded, property);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const bash = new Bash({ fs: shellFs, cwd, env, customCommands: [node],
      commands: ['printf', 'cat', 'echo', 'mkdir', 'ls', 'pwd', 'true', 'false'],
      executionLimits: { maxExecutionTimeMs: timeoutMs },
    });
    preparing = false;
    const result = await bash.exec(shell, { signal: controller.signal, replaceEnv: true, env });
    stdout = result.stdout;
    stderr = result.stderr;
    const failed = executions.find(execution => execution.status !== 'completed');
    if (failed) { status = failed.status; error = failed.error; }
    else if (result.exitCode !== 0) { status = 'failed'; error = `Shell exited with code ${result.exitCode}`; }
    if (result.exitCode === 127) broker.addGap('unsupported', 'Shell command is unavailable in the supported command subset');
  } catch (cause) { status = 'failed'; error = cause instanceof Error ? cause.message : String(cause); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    broker.close();
    controller.abort();
    await Promise.allSettled(pendingExecutions);
  }
  if (timedOut) { status = 'timed-out'; error = 'Session deadline exceeded'; }
  else if (signal?.aborted) { status = 'cancelled'; error = 'Session cancelled'; }
  if (error) broker.addGap('execution', error);
  const snapshot = broker.snapshot();
  return { status, ...(error ? { error } : {}), stdout, stderr, executions: [...executions], events: snapshot.events, coverage: { status: 'incomplete', gaps: snapshot.gaps } };
}
