//! Fake credential-helper coverage for the system Git transport (docs/tasks.md
//! P5-19, docs/specs/system-git-transport.md).
//!
//! A loopback endpoint answers every request with `401` and records the
//! `Authorization` headers Git sends, so a test can prove which configured
//! helper produced the credentials without a hosting provider, a real account,
//! or a stored secret. Provider-specific helpers (GCM, Keychain, libsecret)
//! stay in the manual matrix — see docs/manual-git-compatibility.md.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fjord_git::SystemGitRemoteBackend;
use fjord_ports::{GitOperationContext, GitRemoteBackend, GitRemoteError, RepoPath};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A helper that answers the `get` request with a fixed credential.
const PROVIDING_HELPER: &str = "!f() { echo username=fjord; echo password=s3cr3t-value; }; f";
/// A helper that succeeds without offering anything, like a configured store
/// with no entry for the host.
const SILENT_HELPER: &str = "!f() { :; }; f";
/// A helper that fails outright, like a broken or unavailable store.
const FAILING_HELPER: &str = "!f() { exit 1; }; f";

#[tokio::test]
async fn helper_credentials_reach_the_remote_without_leaking_into_diagnostics() {
    let probe = AuthProbe::start().await;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo, &probe.url());
    add_helper(&repo, PROVIDING_HELPER);

    let error = fetch(&repo).await.unwrap_err();

    assert!(
        matches!(error, GitRemoteError::AuthenticationFailed { .. }),
        "unexpected error: {error:?}"
    );
    assert!(
        probe
            .authorizations()
            .contains(&basic_credentials("fjord", "s3cr3t-value")),
        "the helper credentials never reached the remote: {:?}",
        probe.authorizations()
    );
    assert!(
        !format!("{error:?}").contains("s3cr3t-value"),
        "diagnostics must not carry the helper secret"
    );
}

#[tokio::test]
async fn silent_and_failing_helpers_fall_through_to_the_next_one() {
    let probe = AuthProbe::start().await;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    init_repo(&repo, &probe.url());
    add_helper(&repo, SILENT_HELPER);
    add_helper(&repo, FAILING_HELPER);
    add_helper(&repo, PROVIDING_HELPER);

    let error = fetch(&repo).await.unwrap_err();

    assert!(
        matches!(error, GitRemoteError::AuthenticationFailed { .. }),
        "unexpected error: {error:?}"
    );
    assert!(
        probe
            .authorizations()
            .contains(&basic_credentials("fjord", "s3cr3t-value")),
        "the last helper never got asked: {:?}",
        probe.authorizations()
    );
}

async fn fetch(repo: &Path) -> Result<(), GitRemoteError> {
    tokio::time::timeout(
        Duration::from_secs(120),
        SystemGitRemoteBackend::new().fetch(
            &RepoPath::new(repo.to_path_buf()),
            "origin",
            &[],
            GitOperationContext::default(),
        ),
    )
    .await
    .expect("fetch must not wait for an interactive prompt")
}

fn init_repo(repo: &Path, url: &str) {
    std::fs::create_dir_all(repo).unwrap();
    run_git(repo, &["init", "-b", "main"]);
    run_git(repo, &["remote", "add", "origin", url]);
    // An empty value resets the inherited helper list, so a developer or CI
    // machine with a real credential store cannot influence the test.
    add_helper(repo, "");
}

fn add_helper(repo: &Path, helper: &str) {
    run_git(repo, &["config", "--add", "credential.helper", helper]);
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

/// Loopback endpoint that always demands Basic auth and remembers what it got.
struct AuthProbe {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl AuthProbe {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let recorded = Arc::clone(&recorded);
                tokio::spawn(async move { serve(stream, recorded).await });
            }
        });
        Self { port, seen }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/repo.git", self.port)
    }

    fn authorizations(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

async fn serve(mut stream: TcpStream, seen: Arc<Mutex<Vec<String>>>) {
    let mut request = Vec::new();
    let mut buffer = [0u8; 1024];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&buffer[..read]),
        }
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    for line in String::from_utf8_lossy(&request).lines() {
        if let Some(value) = line.strip_prefix("Authorization: ") {
            seen.lock().unwrap().push(value.trim().to_string());
        }
    }

    let _ = stream
        .write_all(
            b"HTTP/1.1 401 Unauthorized\r\n\
              WWW-Authenticate: Basic realm=\"fjord\"\r\n\
              Content-Length: 0\r\n\
              Connection: close\r\n\r\n",
        )
        .await;
    let _ = stream.shutdown().await;
}

fn basic_credentials(username: &str, password: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let raw = format!("{username}:{password}").into_bytes();
    let mut encoded = String::new();
    for chunk in raw.chunks(3) {
        let mut group = [0u8; 3];
        group[..chunk.len()].copy_from_slice(chunk);
        let packed = u32::from_be_bytes([0, group[0], group[1], group[2]]);
        for index in 0..4 {
            if index <= chunk.len() {
                encoded.push(ALPHABET[(packed >> (18 - index * 6) & 0x3f) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
    }
    format!("Basic {encoded}")
}
