use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fjord_ports::{GitOperationContext, GitProgress, GitRemoteError};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

use super::errors::sanitize_diagnostics;

const STDERR_TAIL_LIMIT: usize = 64 * 1024;
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(40);
#[cfg(unix)]
const TERMINATION_GRACE_PERIOD: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct GitCommandSpec {
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub args: Vec<OsString>,
    pub environment: Vec<(OsString, OsString)>,
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitProcessEvent {
    Stdout(String),
    Stderr(String),
    Progress(GitProgress),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitCommandResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr_tail: String,
}

pub type GitProcessEventHandler = Arc<dyn Fn(GitProcessEvent) + Send + Sync>;

#[derive(Debug, Clone, Default)]
pub struct GitProcessRunner;

impl GitProcessRunner {
    pub async fn run(
        &self,
        spec: &GitCommandSpec,
        context: GitOperationContext,
        event_handler: Option<GitProcessEventHandler>,
    ) -> Result<GitCommandResult, GitRemoteError> {
        if context.is_cancelled() {
            return Err(GitRemoteError::Cancelled);
        }

        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .envs(spec.environment.iter().cloned())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        suppress_console_window(&mut command);
        configure_process_tree(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| GitRemoteError::SpawnFailed(error.to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| GitRemoteError::SpawnFailed("Git stdout pipe is unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| GitRemoteError::SpawnFailed("Git stderr pipe is unavailable".into()))?;

        let stdout_handler = event_handler.clone();
        let stdout_task =
            tokio::spawn(
                async move { read_stream(stdout, StreamKind::Stdout, stdout_handler).await },
            );
        let stderr_task =
            tokio::spawn(
                async move { read_stream(stderr, StreamKind::Stderr, event_handler).await },
            );

        let started = Instant::now();
        let mut poll = tokio::time::interval(CANCELLATION_POLL_INTERVAL);
        let status = loop {
            tokio::select! {
                status = child.wait() => {
                    break status.map_err(|error| GitRemoteError::ProcessFailed {
                        exit_code: None,
                        summary: "failed to wait for Git process".into(),
                        stderr_tail: error.to_string(),
                    })?;
                }
                _ = poll.tick() => {
                    if context.is_cancelled() {
                        terminate_process(&mut child).await;
                        let _ = child.wait().await;
                        finish_reader_tasks(stdout_task, stderr_task).await;
                        return Err(GitRemoteError::Cancelled);
                    }
                    if spec.timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
                        terminate_process(&mut child).await;
                        let _ = child.wait().await;
                        finish_reader_tasks(stdout_task, stderr_task).await;
                        return Err(GitRemoteError::Timeout);
                    }
                }
            }
        };

        let stdout = join_reader(stdout_task, "stdout").await?;
        let stderr = join_reader(stderr_task, "stderr").await?;
        Ok(GitCommandResult {
            exit_code: status.code(),
            stdout: sanitize_diagnostics(&stdout),
            stderr_tail: tail(&sanitize_diagnostics(&stderr), STDERR_TAIL_LIMIT),
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum StreamKind {
    Stdout,
    Stderr,
}

async fn read_stream<R>(
    mut reader: R,
    kind: StreamKind,
    event_handler: Option<GitProcessEventHandler>,
) -> std::io::Result<String>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut record = Vec::new();
    let mut buffer = [0_u8; 8192];

    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            emit_record(kind, &mut record, &event_handler);
            break;
        }

        output.extend_from_slice(&buffer[..count]);
        for byte in &buffer[..count] {
            if matches!(byte, b'\n' | b'\r') {
                emit_record(kind, &mut record, &event_handler);
            } else {
                record.push(*byte);
            }
        }
    }

    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn emit_record(
    kind: StreamKind,
    record: &mut Vec<u8>,
    event_handler: &Option<GitProcessEventHandler>,
) {
    if record.is_empty() {
        return;
    }
    let value = sanitize_diagnostics(&String::from_utf8_lossy(record));
    record.clear();
    if let Some(handler) = event_handler {
        handler(match kind {
            StreamKind::Stdout => GitProcessEvent::Stdout(value),
            StreamKind::Stderr => GitProcessEvent::Stderr(value),
        });
    }
}

#[cfg(unix)]
async fn terminate_process(child: &mut Child) {
    let Some(pid) = child.id() else {
        return;
    };
    let process_group = -(pid as i32);
    // SAFETY: `kill` is called with a process-group id created for this child;
    // no pointers or shared memory cross the FFI boundary.
    unsafe {
        libc::kill(process_group, libc::SIGTERM);
    }
    tokio::time::sleep(TERMINATION_GRACE_PERIOD).await;
    // SAFETY: same validated process-group id as above. ESRCH simply means the
    // group exited during the grace period.
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
}

#[cfg(windows)]
async fn terminate_process(child: &mut Child) {
    let Some(pid) = child.id() else {
        return;
    };

    let mut taskkill = Command::new("taskkill.exe");
    taskkill
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    suppress_console_window(&mut taskkill);
    let _ = tokio::time::timeout(Duration::from_secs(5), taskkill.status()).await;

    if let Err(error) = child.kill().await {
        tracing::debug!(%error, "Git process tree already exited while cancelling");
    }
}

async fn finish_reader_tasks(
    stdout_task: tokio::task::JoinHandle<std::io::Result<String>>,
    stderr_task: tokio::task::JoinHandle<std::io::Result<String>>,
) {
    let _ = stdout_task.await;
    let _ = stderr_task.await;
}

async fn join_reader(
    task: tokio::task::JoinHandle<std::io::Result<String>>,
    stream: &'static str,
) -> Result<String, GitRemoteError> {
    task.await
        .map_err(|error| GitRemoteError::ProcessFailed {
            exit_code: None,
            summary: format!("Git {stream} reader task failed"),
            stderr_tail: error.to_string(),
        })?
        .map_err(|error| GitRemoteError::ProcessFailed {
            exit_code: None,
            summary: format!("failed to read Git {stream}"),
            stderr_tail: error.to_string(),
        })
}

fn tail(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_string();
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

#[cfg(windows)]
fn suppress_console_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console_window(_command: &mut Command) {}

#[cfg(unix)]
fn configure_process_tree(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.as_std_mut().process_group(0);
}

#[cfg(windows)]
fn configure_process_tree(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use super::*;

    fn helper_spec(mode: &str, timeout: Option<Duration>) -> GitCommandSpec {
        GitCommandSpec {
            executable: std::env::current_exe().unwrap(),
            cwd: std::env::current_dir().unwrap(),
            args: vec![
                "--exact".into(),
                "remote::process_runner::tests::runner_helper".into(),
                "--ignored".into(),
                "--nocapture".into(),
            ],
            environment: vec![("FJORD_RUNNER_HELPER".into(), mode.into())],
            timeout,
        }
    }

    #[test]
    #[ignore]
    #[allow(clippy::zombie_processes)]
    fn runner_helper() {
        match std::env::var("FJORD_RUNNER_HELPER").as_deref() {
            Ok("stream") => {
                print!("Counting objects: 1%\rCounting objects: 100%\nfinished\n");
                eprint!("remote: first\rremote: second\n");
            }
            Ok("large-stderr") => eprint!("{}", "x".repeat(STDERR_TAIL_LIMIT * 2)),
            Ok("wait") => std::thread::sleep(Duration::from_secs(30)),
            Ok("tree-parent") => {
                let pid_file = std::env::var_os("FJORD_HELPER_PID_FILE").unwrap();
                let child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "remote::process_runner::tests::runner_helper",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("FJORD_RUNNER_HELPER", "tree-child")
                    .spawn()
                    .unwrap();
                std::fs::write(pid_file, child.id().to_string()).unwrap();
                std::thread::sleep(Duration::from_secs(30));
            }
            Ok("tree-child") => std::thread::sleep(Duration::from_secs(30)),
            _ => {}
        }
    }

    #[tokio::test]
    async fn streams_stdout_and_stderr_records() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let handler: GitProcessEventHandler = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let result = GitProcessRunner
            .run(
                &helper_spec("stream", None),
                GitOperationContext::default(),
                Some(handler),
            )
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            GitProcessEvent::Stdout(value) if value.contains("Counting objects: 1%")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            GitProcessEvent::Stderr(value) if value.contains("remote: second")
        )));
    }

    #[tokio::test]
    async fn bounds_the_stderr_tail() {
        let result = GitProcessRunner
            .run(
                &helper_spec("large-stderr", None),
                GitOperationContext::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.stderr_tail.len(), STDERR_TAIL_LIMIT);
    }

    #[tokio::test]
    async fn cancellation_terminates_the_running_process() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let context = GitOperationContext::new(|_| {}, move || signal.load(Ordering::Relaxed));
        let cancellation = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            cancelled.store(true, Ordering::Relaxed);
        });
        let result = GitProcessRunner
            .run(&helper_spec("wait", None), context, None)
            .await;
        cancellation.await.unwrap();
        assert!(matches!(result, Err(GitRemoteError::Cancelled)));
    }

    #[tokio::test]
    async fn timeout_terminates_the_running_process() {
        let result = GitProcessRunner
            .run(
                &helper_spec("wait", Some(Duration::from_millis(150))),
                GitOperationContext::default(),
                None,
            )
            .await;
        assert!(matches!(result, Err(GitRemoteError::Timeout)));
    }

    #[tokio::test]
    async fn cancellation_terminates_child_processes_too() {
        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("child.pid");
        let mut spec = helper_spec("tree-parent", None);
        spec.environment.push((
            "FJORD_HELPER_PID_FILE".into(),
            pid_file.as_os_str().to_owned(),
        ));

        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let context = GitOperationContext::new(|_| {}, move || signal.load(Ordering::Relaxed));
        let pid_path = pid_file.clone();
        let cancellation = tokio::spawn(async move {
            for _ in 0..100 {
                if pid_path.is_file() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            cancelled.store(true, Ordering::Relaxed);
        });

        let result = GitProcessRunner.run(&spec, context, None).await;
        cancellation.await.unwrap();
        assert!(matches!(result, Err(GitRemoteError::Cancelled)));
        let child_pid = std::fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!process_is_running(child_pid));
    }

    #[cfg(unix)]
    fn process_is_running(pid: u32) -> bool {
        // SAFETY: signal 0 performs existence/permission checking only.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(windows)]
    fn process_is_running(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        // SAFETY: handle ownership is local and closed before returning; the
        // output pointer references a valid local `u32` for the duration call.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut exit_code = 0;
            let success = GetExitCodeProcess(handle, &mut exit_code);
            CloseHandle(handle);
            success != 0 && exit_code == STILL_ACTIVE as u32
        }
    }

    #[test]
    fn redacts_authorization_headers() {
        assert_eq!(
            sanitize_diagnostics("Authorization: Bearer secret"),
            "Authorization: [REDACTED]"
        );
    }
}
