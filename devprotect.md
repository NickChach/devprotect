# DevProtect: Plan and Architecture

## Purpose

Build a local CLI that helps developers evaluate npm packages **before installing them into a project**.

The scanner will inspect package contents and simulate install-time behavior in a controlled environment. It will report suspicious activity, supporting evidence, and any limitations encountered during the scan.

The scanner is a **decision-support tool**. It does not install packages into the developer’s project, and a clean scan does not prove that a package is safe.

This document describes the current plan. No implementation has been created yet.

## Agreed architecture

The core design is:

**V8 isolation + just-bash’s in-memory filesystem + instrumented simulated APIs**

The architecture is inspired by workerd’s capability-based approach, but uses a **custom Rust V8 host** tailored to this scanner.

The intended scan flow is:

1. The CLI identifies the package versions and dependency tree to inspect.
2. The scanner fetches the relevant package archives without executing their install scripts on the host.
3. It performs static analysis of the package contents.
4. It places the package files in a disposable in-memory filesystem.
5. It simulates selected install scripts using just-bash and the custom V8 host.
6. It records simulated filesystem, network, and process activity.
7. It produces a report with findings, evidence, and coverage limitations.

## Technology stack

| Component | Choice | Role |
|---|---|---|
| CLI and orchestration | **Node 26 LTS + TypeScript 7** | Coordinates scans, processes results, and presents the CLI |
| TypeScript compiler | **TypeScript 7 native compiler** | Go-based compiler for type-checking and building |
| CLI arguments | **Node’s built-in `util.parseArgs`** | Parses CLI arguments without Commander |
| npm dependency tree | **`@npmcli/arborist`** | Reads and models npm dependency trees |
| Package retrieval | **`pacote`** | Fetches package metadata and archives |
| Shell and filesystem | **just-bash** | Provides a simulated shell and in-memory filesystem |
| V8 host | **Rust + `rusty_v8`** | Creates V8 isolates and runs compatible package JavaScript |
| Static analysis | **`@babel/parser`** | Parses JavaScript and TypeScript for inspection |
| TypeScript tests | **Vitest** | Tests the CLI and TypeScript components |
| Rust tests | **Rust’s built-in test tooling** | Tests the native host and its interfaces |

The approved JavaScript dependencies are Arborist, Pacote, just-bash, Vitest, and `@babel/parser`, **including their transitive dependencies**. We will keep additional JavaScript dependencies to a minimum.

Node 26 is an LTS release, and TypeScript 7’s native compiler is written in Go. TypeScript 7 improves build and type-checking speed; the running scanner still executes under Node and the Rust V8 host. [Node 26 LTS](https://nodejs.org/en/blog/release/v26.13.0/), [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)

## Component responsibilities

### CLI and coordinator

The TypeScript CLI will:

- Accept a package and version, or a project to inspect.
- Determine the package-manager context where possible.
- Coordinate dependency resolution, fetching, static analysis, and simulation.
- Start and supervise the restricted simulation worker.
- Produce human-readable and machine-readable results.

The scanner will leave the project’s manifests, lockfiles, and `node_modules` unchanged.

### Dependency resolution and retrieval

The scanner needs to identify the exact package versions it is evaluating, including indirect dependencies. When a suitable lockfile is available, it should use it to reproduce the relevant tree as closely as possible.

[Arborist](https://github.com/npm/cli/blob/latest/workspaces/arborist/README.md) fits the npm side of this: it can read npm’s lockfile and model dependency trees. It does not by itself solve Bun lockfile parsing or Bun-specific install behavior.

[Pacote](https://github.com/npm/pacote) can fetch package metadata and archives. Its use must be constrained: its documentation says it can run `prepare` scripts for Git and directory sources. Fetching an untrusted package must not unexpectedly execute that code on the host.

For every package examined, the scanner should record its version, source, and content hash. The later installation is a separate action, so the report must make clear that its findings apply to the examined artifacts and configuration.

### Static analysis

Static analysis examines package contents without executing them. It can identify evidence such as:

- Lifecycle scripts and commands.
- Credential-related paths.
- Network destinations.
- Code that starts processes or downloads executables.
- Embedded binaries or obfuscated code.
- Known advisories, where an advisory source is available.

`@babel/parser` can provide syntax trees for JavaScript and TypeScript. Static findings describe what code appears capable of doing; they do not establish that it executed.

### Simulated shell and filesystem

just-bash provides the shell interpreter and a pure in-memory filesystem. It also supports custom commands, which gives us a way to connect simulated commands to the rest of the scanner. [just-bash documentation](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md)

Each scan should start with disposable state containing:

- The package files and dependency tree needed for the test.
- A simulated working directory and home directory.
- Synthetic credential files, where useful.
- A controlled set of environment variables.

The filesystem contains no real developer credentials. Changes made during the scan are discarded when the scan ends.

### Rust V8 host

The custom native host will be written in Rust using `rusty_v8`, whose Rust crate is named `v8`. It will create and supervise V8 isolates for compatible package JavaScript. [rusty_v8](https://github.com/denoland/rusty_v8)

The host will expose only the capabilities needed for the simulation. It will not provide unrestricted access to the real host filesystem, network, environment, or process creation.

V8 supplies the JavaScript engine, not a complete Node.js runtime. The project must provide the necessary Node-compatible behavior and module loading.

Our native host code will be Rust. V8 itself remains a native C++ engine behind the Rust bindings.

### Virtual APIs and event collection

The simulated shell and JavaScript runtime must use a **shared filesystem view**. A file written through just-bash must be visible to a JavaScript script, and vice versa.

The scanner will provide controlled interfaces for operations such as:

- Reading, writing, and checking virtual files.
- Accessing a synthetic environment.
- Attempting network requests.
- Attempting to launch shell commands or other processes.
- Loading supported JavaScript modules.

A network request can be recorded and given a simulated response without contacting the destination. The report must distinguish what was **observed in simulation** from what was blocked, unsupported, or inferred statically.

Event collection should be controlled by the scanner, not by the package. Package output is untrusted text and should not be treated as an authoritative security event.

## What already fits

The chosen components provide useful foundations:

- **just-bash** already provides a simulated shell, an in-memory filesystem, and custom command support.
- **`rusty_v8`** provides Rust bindings for creating and interacting with V8 isolates.
- **Arborist** can model npm dependency trees.
- **Pacote** can retrieve package metadata and archives.
- **`@babel/parser`** can parse source for static inspection.
- **Vitest** can support testing of the TypeScript components.

These are component capabilities, not evidence that the full scanner has been integrated or validated.

## What still needs to be resolved

### 1. Connecting just-bash to the V8 host

just-bash does not automatically run package JavaScript in our Rust V8 host. We need an adapter that routes a simulated Node-like command to the host and returns its output and events.

just-bash also has optional JavaScript support of its own, but its documented implementation uses QuickJS/WASM. It does not directly implement our chosen Rust/V8 design. [just-bash JavaScript support](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md)

### 2. Sharing filesystem state

The Rust host and just-bash run in different processes. They need a bounded communication interface for virtual filesystem operations.

The difficult case is synchronous Node APIs: JavaScript may require an immediate response while the TypeScript side owns the filesystem. The design must also handle nested commands, timeouts, failures, and cancellation without deadlocks.

The protocol and filesystem ownership model remain to be designed.

### 3. Node and Bun compatibility

The V8 host needs enough compatibility for useful package scripts, potentially including:

- CommonJS and ES module loading.
- Module resolution within the simulated dependency tree.
- Selected `fs`, `path`, `process`, `Buffer`, and timer behavior.
- Simulated `fetch`, HTTP, and process-launching APIs.
- Lifecycle-related environment variables and working directories.

The supported subset must be documented and tested. Missing APIs, unsupported commands, native binaries, and native add-ons should produce **incomplete coverage**, not a clean result.

Bun uses JavaScriptCore, while our simulation uses V8. The scanner can inspect packages intended for Bun, but the test environment will not exactly reproduce Bun’s runtime.

### 4. Install-policy fidelity

The scanner is replaying install behavior; it is not running a normal package-manager installation inside the simulation.

It must determine which scripts would run under the selected package manager, version, project configuration, and platform. It can also offer a separately labeled **exploratory test** of scripts that the selected policy would normally block.

This distinction matters because npm and Bun have different lifecycle-script policies. [npm install-script policy](https://docs.npmjs.com/cli/using-npm/changelog/), [Bun lifecycle scripts](https://bun.com/docs/pm/lifecycle)

### 5. Network simulation

The dynamic simulation should have no unrestricted outbound access. Network APIs and shell commands need controlled implementations that record attempts and return deliberate simulated responses.

The exact behavior remains to be designed. A blocked request may prevent a later payload from appearing; a simulated successful response may cause behavior that would not occur against the real server. The report must identify those conditions.

### 6. Containment of the simulation worker

The in-memory filesystem removes the need for a virtual machine **to represent the filesystem**. Containment is a separate concern.

The simulation worker and Rust host should run as restricted processes with:

- No real credentials or inherited secrets.
- No unrestricted access to the developer’s files or network.
- Limits on execution time, CPU, memory, processes, and output.
- Controlled communication with the scanner.

The OS-level mechanism and supported platforms remain to be selected and validated. A V8 isolate alone should not be treated as the complete host-security boundary.

### 7. Native V8 builds

`rusty_v8` normally downloads a prebuilt V8 static library during the Rust build. We need to pin and verify the native artifacts as well as the Rust dependencies. [rusty_v8 build documentation](https://github.com/denoland/rusty_v8)

Its optional `v8_enable_sandbox` feature is documented as experimental and requires a source or custom V8 build. Whether to use that feature remains an explicit decision; creating a V8 isolate does not automatically settle it. [rusty_v8 experimental features](https://github.com/denoland/rusty_v8#experimental-features)

### 8. Initial package and platform scope

The product should ultimately be useful for developers using npm or Bun. The first supported set still needs to be chosen, including:

- npm lockfiles versus Bun lockfiles.
- Public registry packages versus private registries.
- Git, local-file, and workspace dependencies.
- Supported operating systems and CPU architectures.

A narrow first implementation would make the simulation and reporting easier to validate, but that scope is not yet fixed.

## Report design

A report should identify:

- Exact package versions, sources, and hashes examined.
- The dependency path introducing a finding.
- The package-manager configuration and platform simulated.
- Scripts that ran, were skipped, failed, or could not be simulated.
- Observed file, process, and network events.
- Static findings and relevant known advisories.
- Unsupported operations, timeouts, and other coverage gaps.

An example finding:

> **Suspicious behavior — `helper-package@2.4.1`**
>
> During a simulated install script, the package read a fake npm credential file and attempted to send its contents to an external address. The request was simulated.
>
> Introduced by: `example-package → helper-package`.
>
> The script also attempted to run an unsupported native executable, so the scan is incomplete.

The scanner should use wording such as **“no suspicious behavior observed”**, not declare a package safe.

## Validation plan

The first proof of concept should validate the most important integration:

1. A just-bash command creates a fake credential file.
2. JavaScript running in the Rust-hosted V8 isolate reads that same file synchronously.
3. The script passes the fake value to a simulated network API.
4. The scanner records the events without accessing the real filesystem or network.

Further validation should cover benign packages, synthetic malicious behaviors, unsupported operations, resource limits, archive handling, and differences between simulated lifecycle behavior and the selected package manager’s real behavior. The results should measure both detection and incomplete coverage.
