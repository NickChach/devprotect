# Runtime protocol v1 and reusable fixture API

The wire protocol remains version 1. This implementation generalizes the broker
and session API while retaining strictly sequential synchronous execution.
All inputs and backends are trusted synthetic fixtures until OS containment is
implemented. The CLI accepts no user-provided runtime source or shell text.

## Ownership and API

`RuntimeBroker` owns access to one caller-supplied `IFileSystem`. The caller should
provide an `InMemoryFs` with a storage limit, seed it before execution, and avoid
mutating it concurrently. Filesystem backends and policies are trusted host code;
passing a real-filesystem backend would grant it real effects and is outside this
prototype's intended use. The broker copies policy configuration at construction.

`runSyntheticSession` accepts the backend, read/write roots, exact simulated URL
responses, virtual cwd, explicit environment, shell fixture, worker binary,
timeout, and optional AbortSignal. `executeJavaScript` is the lower-level API for
one synchronous script against that broker. A session may execute several scripts
sequentially; it has a total deadline. Nested execution is unsupported.

Filesystem paths use POSIX normalization and directory-boundary checks. Relative
JavaScript paths use the invoking shell command's cwd. Existing final or ancestor
symlinks are rejected. The policy is an allow-list of read and write roots;
there are no exclusions inside a granted root. The caller must not seed hard links
across policy boundaries. Shell copy/move/link/removal/permission operations are
unsupported, so execution cannot introduce cross-boundary aliases.

just-bash creates virtual command stubs during trusted constructor setup. That
setup uses the raw backend and is not a guest event. After initialization the
shell receives only the guarded filesystem interface. Policies must allow reads
of `/usr/bin` and `/bin` if command resolution requires those virtual stubs.
No operating-system command is launched by the shell; only its custom `node`
command can start the configured Rust worker.

Supported shell utilities: printf, cat, echo, mkdir, ls, pwd, true, false, plus
just-bash builtins and the custom node command. Other utilities are unavailable.
A final command-not-found status creates a coverage gap; failures swallowed by
shell control flow are not exhaustively classified. The shell subset is always
part of incomplete coverage. Real network features are disabled for the shell.

## Capability requests

stdin/stdout carry newline-delimited UTF-8 JSON, max 65,536 bytes including newline.
The coordinator sends one initialization frame:

```json
{"type":"execute","version":1,"source":"/* synthetic script */"}
```

JavaScript calls the synchronous `__hostCall` with a JSON string. Rust forwards:

```json
{"type":"request","request":{"operation":"read","target":"/workspace/input.txt"}}
```

The broker asynchronously services the request while Rust blocks, then responds:

```json
{"type":"response","ok":true,"value":"synthetic content"}
```

Errors use `ok: false` and an error string. Available operations are `read`,
`write`, `append`, `exists`, `stat`, `readdir`, `mkdir`, and `network`. Reads return
UTF-8 strings; writes/appends accept string bodies up to 16 KiB. Network bodies
have the same limit. `mkdir` creates one directory level. Metadata is serialized
as JSON data rather than Node Stat instances. These are fixture APIs, not a Node
implementation. Supplied fixture code provides tiny synchronous convenience
wrappers; there is no CommonJS loader or asynchronous event loop.

Network requests are recorded and receive the configured status/body plus
`simulated: true`. Missing destinations are denied. No network request is sent.
Shell and JavaScript requests use the same policy and authoritative filesystem.
The shell can also use read-buffer, metadata, and directory-query methods needed
by just-bash. Unimplemented filesystem methods fail explicitly.

Rust finishes with:

```json
{"type":"done","success":true,"error":null}
```

The coordinator requires that completion plus a zero exit status. It rejects
malformed, oversized, out-of-sequence, and trailing frames. At most one request is
outstanding. Multiplexing or asynchronous guest execution needs a protocol revision.

## Results and event collection

Execution returns a `RuntimeResult`, including operational failures:

- `status`: completed, failed, timed-out, cancelled, protocol-error, or unavailable.
- `error`: optional bounded diagnostic.
- `events`: ordered sequence, actor (shell/javascript/loader), operation, target,
  and outcome (simulated/denied/unsupported/failed). Network events include the
  bounded synthetic request body.
- `coverage`: always incomplete, with denied, unsupported, and execution gaps.

Capability denials and unsupported operations remain in coverage even if guest
code catches their errors and completes. A completion status means only that
execution finished. Snapshots copy event data; caller changes cannot rewrite the
broker's history. Execution errors, deadlines, cancellation and worker failure
preserve events observed before termination. Fatal worker failure revokes broker
capabilities; session teardown always revokes them. Failed operations such as a
missing file are recorded without being automatically called malicious.

Events come from broker-controlled capability operations, not package stdout.
They establish that an operation reached the broker, not the guest's intent or
data flow. Loader file reads and trusted initialization are distinguished from
guest activity. Filesystem events reserve a trace slot before entering the backend.

## Limits and remaining boundaries

The broker retains at most 10,000 events. At the limit it stops additional
operations and records a gap. The caller controls filesystem storage limits.
The Rust worker retains the existing 32 MiB V8 heap limit, 64 KiB protocol frame
limit, 1 MiB total stdout limit and 64 KiB stderr limit. Worker deadlines and
cancellation terminate its process; results wait for worker close. Synchronous
fixture API calls are the only supported execution model.

These controls do not provide OS containment, process-tree limits, or guaranteed
termination of arbitrary host callbacks. Backend calls are trusted, cooperative
in-memory operations. CPU containment for the shell, native artifact verification,
Node compatibility, lifecycle policy, and general package execution are future work.
