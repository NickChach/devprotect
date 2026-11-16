# Runtime prototype protocol v1

This is an implemented experimental contract, not a finalized general runtime
protocol. The TypeScript broker owns the single just-bash in-memory filesystem.
Rust never maintains a second copy of it.

The coordinator starts one worker per execution with an empty environment.
stdin/stdout carry newline-delimited UTF-8 JSON. stderr contains worker
diagnostics and is never interpreted as authoritative events. Each frame is at
most 65,536 bytes including its newline. stdout and stderr are bounded; the
supervisor kills the worker on timeout, abort, malformed messages, or overflow.

The coordinator sends:

```json
{"type":"execute","version":1,"source":"/* built-in fixture */"}
```

The V8 isolate exposes a single synchronous host callback, `__hostCall`, which
accepts a JSON string. Rust sends the parsed request and blocks for a response:

```json
{"type":"request","request":{"operation":"read","target":"/home/synthetic/.npmrc"}}
```

The coordinator awaits the filesystem operation without blocking its own event
loop, records the event itself, and replies:

```json
{"type":"response","ok":true,"value":"DEVPROTECT_FAKE_TOKEN"}
```

Denied requests receive `ok: false` and an error. Allowed prototype operations:

| Operation | Exact target | Result |
| --- | --- | --- |
| `read` | `/home/synthetic/.npmrc` | Virtual UTF-8 text |
| `write` | `/fixture/result.txt` | Write string body to virtual file |
| `network` | `https://collector.invalid/collect` | Record string body, return synthetic 204 |

Rust returns the response string to the JavaScript callback. Once synchronous
execution finishes it emits:

```json
{"type":"done","success":true,"error":null}
```

The coordinator requires a successful completion frame and zero exit status.
There is at most one outstanding request. No multiplexing or request IDs are
needed under this restricted contract. Multiple outstanding requests, nested
commands, asynchronous guest execution, and process spawning are unsupported.
Adding any of them requires a protocol revision and explicit scheduling design.

The broker's events establish that a capability request reached its interface.
They do not prove the origin or intent of arbitrary guest code. The prototype's
fixed request target and synthetic response are deliberately narrow.

The V8 heap is limited to 32 MiB; the coordinator defaults to a 5-second worker
deadline, 1 MiB stdout total, and 64 KiB stderr total. These do not constitute
complete process-memory, CPU, or host-security containment. Rust IPC waits are
bounded by the external worker deadline. All virtual state is discarded after
the demo.
