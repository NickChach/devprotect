use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

const MAX_FRAME: usize = 64 * 1024;

fn read_frame(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|e| e.to_string())?;
        if available.is_empty() {
            return Err("Unexpected protocol EOF".into());
        }
        let end = available.iter().position(|b| *b == b'\n');
        let count = end.map_or(available.len(), |i| i + 1);
        if frame.len() + count > MAX_FRAME {
            return Err("Protocol frame exceeds limit".into());
        }
        frame.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            return serde_json::from_slice(&frame).map_err(|e| e.to_string());
        }
    }
}

fn send(value: Value) -> Result<(), String> {
    let frame = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    if frame.len() + 1 > MAX_FRAME {
        return Err("Protocol frame exceeds limit".into());
    }
    let mut out = io::stdout().lock();
    out.write_all(&frame).map_err(|e| e.to_string())?;
    out.write_all(b"\n").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}

// The guest has no Node bindings. This callback delegates only to the broker.
fn host_call(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    let response = (|| -> Result<String, String> {
        if !args.get(0).is_string() {
            return Err("Host call requires a JSON string".into());
        }
        let raw = args.get(0).to_rust_string_lossy(scope);
        if raw.len() > MAX_FRAME / 2 {
            return Err("Host call exceeds limit".into());
        }
        let request: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        send(json!({"type": "request", "request": request}))?;
        let response = read_frame(&mut io::stdin().lock())?;
        if response["type"] != "response" {
            return Err("Expected broker response".into());
        }
        Ok(response.to_string())
    })();
    match response {
        Ok(response) => {
            let value = v8::String::new(scope, &response).unwrap();
            result.set(value.into());
        }
        Err(message) => {
            let message = v8::String::new(scope, &message).unwrap();
            let error = v8::Exception::error(scope, message);
            scope.throw_exception(error);
        }
    }
}

fn run() -> Result<(), String> {
    let initial = read_frame(&mut io::stdin().lock())?;
    if initial["type"] != "execute" || initial["version"] != 1 {
        return Err("Unsupported protocol initialization".into());
    }
    let source = initial["source"].as_str().ok_or("Missing source")?;
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
    let isolate =
        &mut v8::Isolate::new(v8::CreateParams::default().heap_limits(0, 32 * 1024 * 1024));
    v8::scope!(let scope, isolate);
    let global = v8::ObjectTemplate::new(scope);
    let name = v8::String::new(scope, "__hostCall").unwrap();
    global.set(
        name.into(),
        v8::FunctionTemplate::new(scope, host_call).into(),
    );
    let context = v8::Context::new(
        scope,
        v8::ContextOptions {
            global_template: Some(global),
            ..Default::default()
        },
    );
    let scope = &mut v8::ContextScope::new(scope, context);
    v8::tc_scope!(let scope, scope);
    let source = v8::String::new(scope, source).ok_or("Source allocation failed")?;
    let success = v8::Script::compile(scope, source, None)
        .and_then(|script| script.run(scope))
        .is_some();
    let error = if success {
        None
    } else {
        Some(
            scope
                .exception()
                .map(|e| e.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Execution failed".into()),
        )
    };
    send(json!({"type": "done", "success": success, "error": error}))
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Runtime: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_protocol() {
        assert_eq!(
            read_frame(&mut &b"{\"version\":1}\n"[..]).unwrap()["version"],
            1
        );
        assert!(read_frame(&mut &b"{}"[..]).is_err());
        assert!(read_frame(&mut &b"not-json\n"[..]).is_err());
        let oversized = vec![b'x'; MAX_FRAME + 1];
        assert!(read_frame(&mut oversized.as_slice()).is_err());
    }
}
