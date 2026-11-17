# DevProtect

Local package inspection with evidence and explicit coverage limits. This is the
first implementation of the architecture in `devprotect.md`.

## Getting started

Use Node 26 (see `.nvmrc`) and npm. The compiler is TypeScript 7.

```sh
nvm use
npm ci --ignore-scripts
npm run check
node dist/cli.js scan ./fixtures/indicators
node dist/cli.js scan ./fixtures/benign --json
```

The scanner accepts an existing local package directory containing a name and
version in `package.json`. It inventories files, hashes their bytes with SHA-256,
lists manifest scripts, and parses JavaScript/TypeScript for literal references
to credential paths, network destinations, and process APIs. These indicators
are evidence for review, not determinations of maliciousness. Package code and
manifest scripts are never executed by `scan`.

Reports are available as text or versioned JSON. Every report currently has
incomplete coverage: dependencies, advisory queries, and package simulation are
not implemented. A successful exit means a report was produced; it is not a
security verdict. Exit codes are 0 for a report, 1 for an operational failure,
and 2 for invalid CLI arguments.

File limits are 1 MiB per file, 32 MiB total, 10,000 directory entries, and 32
directory levels. Skipped links, excluded `node_modules`/`.git` directories,
oversized files, and parse failures appear as coverage gaps. Hashes identify
inventoried file bytes, not a registry archive or a verified installation.
Use stable local directories: this initial implementation does not provide an
atomic snapshot or prevent ancestor-directory replacement races. Static parsing
currently runs inside the coordinator and has no separate CPU containment.

## Rust/V8 integration prototype

Install Rust, a native linker, and the platform prerequisites for
[rusty_v8](https://github.com/denoland/rusty_v8). The first build downloads the
pinned V8 binding's prebuilt native library.

```sh
npm run runtime:build
npm run build
npm run runtime:demo
npm test
cargo test --locked --manifest-path runtime/Cargo.toml
cargo clippy --locked --manifest-path runtime/Cargo.toml --all-targets -- -D warnings
```

The demo runs a credential fixture through the reusable session API: just-bash
writes a synthetic token, V8 reads it synchronously, the broker records a
simulated request, and the shell reads a JavaScript-created file. To run all
built-in fixtures:

```sh
node dist/cli.js runtime-fixtures --json
```

The fixture suite covers credential access, a file transformation, failure after
a read, and caught denied/unsupported operations. A deliberately failing fixture
returns `status: "failed"`; its preceding events remain available.

The runtime accepts a caller-supplied virtual filesystem, capability policy,
simulated network responses, cwd/environment, timeout, and cancellation signal.
`src/runtime/session.ts` exports `runSyntheticSession`; `bridge.ts` exports the
lower-level `executeJavaScript`. These internal APIs accept trusted fixtures.
The CLI has no option to execute user-supplied package code.

The broker applies read/write directory grants to shell and JavaScript operations.
It logs ordered events with shell, JavaScript, or loader attribution. It blocks
virtual symlinks and unsupported filesystem operations. Caught capability denials
and unsupported requests remain coverage gaps. Network responses are configured
simulation data, with no real outgoing requests. Guest code exposes only tiny
synchronous fixture wrappers; there is no Node module loader or event loop.

Executions return structured completed/failed/timed-out/cancelled/protocol-error/
unavailable results, retaining events on failure. Sessions enforce a shared
deadline and revoke capabilities on teardown. See the protocol document for
supported operations, bootstrap behavior and event limits.

**OS containment is not implemented.** The worker binary and internal APIs remain
development tools for synthetic inputs. V8 artifact verification, process resource
limits, Node compatibility, and lifecycle replay remain future work.

Native integration tests are explicitly skipped until the Rust binary exists.
Build it before running `npm test` to exercise the complete test suite.

## Implementation structure

- `src/scan.ts`: bounded local inventory and scan coordination.
- `src/analyze.ts`: initial static rules and AST traversal.
- `src/model.ts`, `src/report.ts`: report contract and terminal-safe rendering.
- `src/runtime/`: capability broker, worker supervisor, reusable sessions, result types, and built-in fixtures.
- `runtime/`: Rust/V8 worker and bounded protocol reader.
- `docs/runtime-protocol.md`: provisional ownership and protocol decisions.
- `tests/`, `fixtures/`: scanner and runtime validation.

Dependencies are pinned in the npm and Cargo lockfiles. The `guarded-fetch`
override updates its pinned `undici` dependency to the patched 7.30.1 release;
retain it until the upstream dependency updates. Optional Python/QuickJS and
real-network features of just-bash are not enabled.

Next implementation decisions are the OS containment backend, the first Node API
subset, and supported registry/lockfile inputs. Arborist and Pacote are not yet
dependencies because resolution and fetching are not implemented.
