import { InMemoryFs } from 'just-bash';
import { expect, it } from 'vitest';
import { RuntimeBroker } from '../src/runtime/broker.js';

function setup(maxEvents = 100) {
  const fs = new InMemoryFs({ '/allowed/input': 'hello', '/private/secret': 'secret' });
  const broker = new RuntimeBroker(fs, { read: ['/allowed'], write: ['/allowed'], network: { 'https://example.invalid': { status: 201, body: 'fixture response' } } }, '/allowed', maxEvents);
  return { fs, broker };
}
it('normalizes relative paths and enforces directory boundaries', async () => {
  const { broker } = setup();
  expect(await broker.request({ operation: 'read', target: 'input' })).toMatchObject({ ok: true, value: 'hello' });
  for (const target of ['/allowed-other/input', '/allowed/../private/secret']) expect((await broker.request({ operation: 'read', target })).ok).toBe(false);
});
it('applies the same capability policy to shell file operations', async () => {
  const { fs, broker } = setup();
  const shell = broker.filesystem('shell');
  await expect(shell.writeFile('/private/secret', 'changed')).rejects.toThrow('denied');
  expect(await fs.readFile('/private/secret')).toBe('secret');
  await expect(shell.cp('/allowed/input', '/allowed/copy')).rejects.toThrow('Unsupported');
});
it('blocks final and ancestor symbolic links', async () => {
  const { fs, broker } = setup();
  await fs.symlink('/private', '/allowed/link');
  await fs.symlink('/private/secret', '/allowed/file');
  expect((await broker.request({ operation: 'read', target: '/allowed/link/secret' })).ok).toBe(false);
  expect((await broker.request({ operation: 'write', target: '/allowed/file', body: 'changed' })).ok).toBe(false);
  expect(await fs.readFile('/private/secret')).toBe('secret');
  expect(broker.snapshot().gaps).toContainEqual(expect.objectContaining({ kind: 'unsupported' }));
});
it('returns configured network responses and records denied destinations', async () => {
  const { broker } = setup();
  expect(await broker.request({ operation: 'network', target: 'https://example.invalid', body: 'synthetic' })).toMatchObject({ ok: true, value: { status: 201, body: 'fixture response', simulated: true } });
  expect((await broker.request({ operation: 'network', target: 'https://other.invalid', body: '' })).ok).toBe(false);
  expect(broker.snapshot().events.map(event => event.outcome)).toEqual(['simulated', 'denied']);
});
it('keeps filesystem failures distinct from denied and unsupported requests', async () => {
  const { broker } = setup();
  expect((await broker.request({ operation: 'read', target: '/allowed/missing' })).ok).toBe(false);
  expect(broker.snapshot().events[0]?.outcome).toBe('failed');
});
it('caps events before further side effects and returns independent snapshots', async () => {
  const { fs, broker } = setup(1);
  await broker.request({ operation: 'read', target: '/allowed/input' });
  expect((await broker.request({ operation: 'write', target: '/allowed/input', body: 'changed' })).ok).toBe(false);
  expect(await fs.readFile('/allowed/input')).toBe('hello');
  const snapshot = broker.snapshot();
  snapshot.events[0]!.target = 'tampered';
  expect(broker.snapshot().events[0]?.target).toBe('/allowed/input');
});
it('revokes pending operations before they reach the backend', async () => {
  const { fs, broker } = setup();
  const write = broker.request({ operation: 'write', target: '/allowed/input', body: 'changed' });
  broker.close();
  expect((await write).ok).toBe(false);
  expect(await fs.readFile('/allowed/input')).toBe('hello');
});
