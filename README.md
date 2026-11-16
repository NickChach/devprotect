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

The demo executes one built-in synthetic fixture:

1. just-bash writes `DEVPROTECT_FAKE_TOKEN` to its in-memory filesystem.
2. A custom `node` command launches the separate Rust/V8 worker.
3. JavaScript synchronously reads that same virtual file through the broker.
4. The broker records a simulated request containing the fake token and returns
   a synthetic HTTP 204 response. It performs no network request.
5. JavaScript writes another virtual file, which just-bash then reads.

The output includes both checks and the coordinator-recorded events. The demo
uses tiny fixture APIs; there is no `require`, Node module loader, asynchronous
event loop, or actual package lifecycle replay. Guest stdout cannot create
security events. The worker inherits an empty environment; protocol frames,
output, execution time, and V8 heap size have limits. The supervisor supports
deadline termination and cancellation.

**OS containment is not implemented.** The CLI therefore exposes only the fixed
demo, with no option for running target package code. The worker binary and
internal bridge are development tools, not a secure service for arbitrary code.
V8 native artifact verification, OS resource limits, general Node compatibility,
and nested execution remain future work.

Native integration tests are explicitly skipped until the Rust binary exists.
Build it before running `npm test` to exercise the complete initial test suite.

## Implementation structure

- `src/scan.ts`: bounded local inventory and scan coordination.
- `src/analyze.ts`: initial static rules and AST traversal.
- `src/model.ts`, `src/report.ts`: report contract and terminal-safe rendering.
- `src/runtime/`: fixture broker and just-bash integration.
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
