import { posix } from 'node:path';
import type { IFileSystem } from 'just-bash';
import type { Actor, BrokerResponse, CapabilityPolicy, RuntimeEvent, RuntimeGap } from './types.js';

const READ = new Set(['readFile', 'readFileBuffer', 'readFileBytes', 'exists', 'stat', 'lstat', 'readdir', 'readdirWithFileTypes', 'realpath']);
const UNSUPPORTED = new Set(['createExclusive', 'rm', 'cp', 'mv', 'chmod', 'symlink', 'link', 'readlink', 'utimes']);
const WRITE = new Set(['writeFile', 'appendFile', 'mkdir']);
const ALIASES: Record<string, string> = { read: 'readFile', write: 'writeFile', append: 'appendFile', exists: 'exists', stat: 'stat', readdir: 'readdir', mkdir: 'mkdir' };
const OPERATIONS: Record<string, string> = { readFile: 'file-read', readFileBuffer: 'file-read', readFileBytes: 'file-read', writeFile: 'file-write', appendFile: 'file-append', mkdir: 'directory-create', exists: 'file-exists', stat: 'file-stat', lstat: 'file-stat', readdir: 'directory-read', readdirWithFileTypes: 'directory-read', realpath: 'path-resolve' };

export class RuntimeBroker {
  private readonly events: RuntimeEvent[] = [];
  private readonly gaps: RuntimeGap[] = [];
  private active = true;
  private readonly policy: CapabilityPolicy;
  constructor(private readonly fs: IFileSystem, policy: CapabilityPolicy, private readonly cwd = '/', private readonly maxEvents = 10_000) {
    if (!posix.isAbsolute(cwd)) throw new Error('Virtual cwd must be absolute');
    for (const root of [...policy.read, ...policy.write]) if (!posix.isAbsolute(root)) throw new Error('Capability roots must be absolute');
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error('Invalid event limit');
    this.policy = { read: policy.read.map(root => posix.normalize(root)), write: policy.write.map(root => posix.normalize(root)), network: structuredClone(policy.network) };
  }
  snapshot() { return { events: this.events.map(event => ({ ...event })), gaps: this.gaps.map(gap => ({ ...gap })) }; }
  close() { this.active = false; }
  addGap(kind: RuntimeGap['kind'], reason: string) {
    if (!this.gaps.some(gap => gap.kind === kind && gap.reason === reason)) this.gaps.push({ kind, reason });
  }
  private assertActive() { if (!this.active) throw new Error('Runtime capabilities revoked'); }
  private allowed(path: string, roots: readonly string[]) { return roots.some(root => root === '/' || path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)); }
  private record(actor: Actor, operation: string, target: string, outcome: RuntimeEvent['outcome'], body?: string) {
    this.assertActive();
    if (this.events.length >= this.maxEvents) { this.addGap('execution', 'Event limit reached'); throw new Error('Runtime event limit reached'); }
    const event = { sequence: this.events.length + 1, actor, operation, target, outcome, ...(body === undefined ? {} : { body }) };
    this.events.push(event);
    return event;
  }
  private async noLinks(path: string) {
    let current = '/';
    for (const part of path.split('/').filter(Boolean)) {
      current = posix.join(current, part);
      try {
        if ((await this.fs.lstat(current)).isSymbolicLink) throw new Error('Virtual symbolic links are unsupported');
      } catch (error) {
        if (String(error).includes('ENOENT')) break;
        throw error;
      }
    }
  }
  filesystem(actor: Actor): IFileSystem {
    // Only the declared IFileSystem surface is exposed. Unsupported shell operations
    // cannot reach a raw backend method. Backend internal calls stay bound to itself.
    return new Proxy({} as IFileSystem, {
      get: (_target, property) => {
        if (property === 'resolvePath') return (base: string, path: string) => posix.resolve(base, path);
        if (property === 'getAllPaths') return () => { this.record(actor, 'filesystem-list', this.cwd, 'simulated'); return this.fs.getAllPaths().filter(path => this.allowed(path, this.policy.read)); };
        if (typeof property !== 'string' || (!READ.has(property) && !WRITE.has(property) && !UNSUPPORTED.has(property))) return undefined;
        return (...args: unknown[]) => this.fileOperation(actor, property, args);
      },
    });
  }
  private async fileOperation(actor: Actor, method: string, args: unknown[], cwd = this.cwd): Promise<unknown> {
    this.assertActive();
    const raw = args[0];
    if (typeof raw !== 'string' || raw.length > 4096 || raw.includes('\0')) throw new Error('Invalid virtual path');
    const path = posix.resolve(cwd, raw);
    const operation = OPERATIONS[method] ?? method;
    if (!READ.has(method) && !WRITE.has(method)) {
      this.record(actor, operation, path, 'unsupported');
      this.addGap('unsupported', `Filesystem operation ${method} is unsupported`);
      throw new Error(`Unsupported filesystem operation: ${method}`);
    }
    if (!this.allowed(path, READ.has(method) ? this.policy.read : this.policy.write)) {
      this.record(actor, operation, path, 'denied');
      this.addGap('denied', `Filesystem capability denied: ${operation} ${path}`);
      throw new Error(`Filesystem capability denied: ${path}`);
    }
    // Reserve capacity before performing a side effect, so it can always be logged.
    if (this.events.length >= this.maxEvents) { this.addGap('execution', 'Event limit reached'); throw new Error('Runtime event limit reached'); }
    const event = this.record(actor, operation, path, 'failed');
    try {
      await this.noLinks(path);
      this.assertActive();
      const fn = this.fs[method as keyof IFileSystem];
      if (typeof fn !== 'function') throw new Error(`Backend does not implement ${method}`);
      const result = await Reflect.apply(fn, this.fs, [path, ...args.slice(1)]);
      this.assertActive();
      event.outcome = 'simulated';
      return result;
    } catch (error) {
      if (String(error).includes('symbolic links')) this.addGap('unsupported', 'Virtual symbolic links are unsupported');
      throw error;
    }
  }
  async request(input: unknown, cwd?: string): Promise<BrokerResponse> {
    try {
      this.assertActive();
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid capability request');
      const request = input as Record<string, unknown>;
      if (typeof request.operation !== 'string' || typeof request.target !== 'string' || request.target.length > 4096) throw new Error('Invalid capability request');
      const { operation, target } = request;
      if (operation === 'network') {
        if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 16_384) throw new Error('Network body must be a string of at most 16 KiB');
        const response = Object.hasOwn(this.policy.network, target) ? this.policy.network[target] : undefined;
        this.record('javascript', 'network-attempt', target, response ? 'simulated' : 'denied', request.body);
        if (!response) { this.addGap('denied', `Network capability denied: ${target}`); throw new Error('Network capability denied'); }
        return { type: 'response', ok: true, value: { ...response, simulated: true } };
      }
      const method = Object.hasOwn(ALIASES, operation) ? ALIASES[operation] : undefined;
      if (!method) {
        this.record('javascript', operation.slice(0, 120), target, 'unsupported');
        this.addGap('unsupported', `Capability operation ${operation.slice(0, 120)} is unsupported`);
        throw new Error('Unsupported capability operation');
      }
      if (['write', 'append'].includes(operation) && (typeof request.body !== 'string' || Buffer.byteLength(request.body) > 16_384)) throw new Error('File body must be a string of at most 16 KiB');
      const args = ['write', 'append'].includes(operation) ? [target, request.body] : [target];
      return { type: 'response', ok: true, value: await this.fileOperation('javascript', method, args, cwd) ?? null };
    } catch (error) { return { type: 'response', ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}
