use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;
use tauri::Emitter;

#[derive(Debug)]
struct TerminalProcess {
    stdin: ChildStdin,
    child: Child,
}

static TERMINALS: OnceLock<Mutex<HashMap<String, TerminalProcess>>> = OnceLock::new();
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

fn terminals() -> &'static Mutex<HashMap<String, TerminalProcess>> {
    TERMINALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_handle() -> &'static tauri::AppHandle {
    APP_HANDLE.get().expect("AppHandle not initialized")
}

pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
    println!("[terminal] AppHandle initialized");
}

#[tauri::command]
pub fn terminal_spawn(id: String) -> Result<(), String> {
    println!("[terminal] terminal_spawn called with id={}", id);
    let mut terms = terminals().lock().map_err(|e| e.to_string())?;

    if terms.contains_key(&id) {
        eprintln!("[terminal] already exists: {}", id);
        return Err(format!("Terminal already exists: {}", id));
    }

    let mut child = Command::new("script")
        .arg("-q")
        .arg("/dev/null")
        .arg("bash")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn bash: {e}"))?;

    println!("[terminal] bash spawned, pid={}", child.id());

    let stdin = child.stdin.take().ok_or("Failed to take stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to take stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to take stderr")?;

    let id_stdout = id.clone();
    let handle_stdout = app_handle().clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    println!("[terminal] stdout EOF: {}", id_stdout);
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    println!("[terminal] stdout {} bytes from {}", n, id_stdout);
                    let _ = handle_stdout.emit(&format!("terminal:data:{}", id_stdout), data);
                }
                Err(e) => {
                    eprintln!("[terminal] stdout read error: {} {}", id_stdout, e);
                    break;
                }
            }
        }
    });

    let id_stderr = id.clone();
    let handle_stderr = app_handle().clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = handle_stderr.emit(&format!("terminal:data:{}", id_stderr), data);
                }
                Err(e) => {
                    eprintln!("[terminal] stderr read error: {} {}", id_stderr, e);
                    break;
                }
            }
        }
    });

    terms.insert(id, TerminalProcess { stdin, child });
    Ok(())
}

#[tauri::command]
pub fn terminal_write(id: String, data: String) -> Result<(), String> {
    println!("[terminal] write to {}: {:?}", id, data);
    let mut terms = terminals().lock().map_err(|e| e.to_string())?;
    let proc = terms
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal not found: {}", id))?;
    proc.stdin
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write error: {e}"))?;
    proc.stdin.flush().map_err(|e| format!("Flush error: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(id: String) -> Result<(), String> {
    println!("[terminal] kill {}", id);
    let mut terms = terminals().lock().map_err(|e| e.to_string())?;
    if let Some(mut proc) = terms.remove(&id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(_id: String, _cols: u16, _rows: u16) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn terminal_list() -> Result<Vec<String>, String> {
    let terms = terminals().lock().map_err(|e| e.to_string())?;
    Ok(terms.keys().cloned().collect())
}
