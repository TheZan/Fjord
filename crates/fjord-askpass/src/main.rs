#![cfg_attr(windows, windows_subsystem = "windows")]

use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum PromptKind {
    Username,
    Secret,
    Confirmation,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AskpassRequest<'a> {
    token: &'a str,
    operation_id: &'a str,
    prompt_id: &'a str,
    prompt: &'a str,
    kind: PromptKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskpassResponse {
    prompt_id: String,
    status: ResponseStatus,
    value: Option<String>,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ResponseStatus {
    Answered,
    Cancelled,
    TimedOut,
    OperationCancelled,
}

fn main() -> ExitCode {
    match run() {
        Ok(value) => {
            println!("{value}");
            if std::io::stdout().flush().is_err() {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            // Fixed diagnostics only: never include prompt, token, address, or response.
            eprintln!("fjord-askpass: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, &'static str> {
    let address = required_env("FJORD_ASKPASS_ADDRESS")?
        .parse::<SocketAddr>()
        .map_err(|_| "invalid broker address")?;
    if !address.ip().is_loopback() {
        return Err("broker address is not loopback");
    }
    let token = required_env("FJORD_ASKPASS_TOKEN")?;
    let operation_id = required_env("FJORD_ASKPASS_OPERATION_ID")?;
    let prompt = env::args().nth(1).ok_or("missing prompt")?;
    let prompt_id = prompt_id();
    exchange(
        address,
        &AskpassRequest {
            token: &token,
            operation_id: &operation_id,
            prompt_id: &prompt_id,
            prompt: &prompt,
            kind: classify_prompt(&prompt),
        },
    )
}

fn required_env(name: &str) -> Result<String, &'static str> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or("missing broker environment")
}

fn prompt_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("prompt-{}-{nanos}", std::process::id())
}

fn classify_prompt(prompt: &str) -> PromptKind {
    let prompt = prompt.to_ascii_lowercase();
    if prompt.contains("username") || prompt.contains("user name") {
        PromptKind::Username
    } else if prompt.contains("password")
        || prompt.contains("passphrase")
        || prompt.contains("pin for")
    {
        PromptKind::Secret
    } else if prompt.contains("yes/no")
        || prompt.contains("yes or no")
        || prompt.contains("continue connecting")
        || prompt.contains("confirm")
    {
        PromptKind::Confirmation
    } else {
        PromptKind::Unknown
    }
}

fn exchange(address: SocketAddr, request: &AskpassRequest<'_>) -> Result<String, &'static str> {
    let mut stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
        .map_err(|_| "could not connect to broker")?;
    stream
        .set_read_timeout(Some(RESPONSE_TIMEOUT))
        .map_err(|_| "could not configure broker connection")?;
    stream
        .set_write_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|_| "could not configure broker connection")?;
    serde_json::to_writer(&mut stream, request).map_err(|_| "could not encode request")?;
    stream
        .write_all(b"\n")
        .map_err(|_| "could not send request")?;
    stream.flush().map_err(|_| "could not send request")?;

    let mut response_line = String::new();
    BufReader::new(stream)
        .take(MAX_RESPONSE_BYTES)
        .read_line(&mut response_line)
        .map_err(|_| "could not read broker response")?;
    let response: AskpassResponse =
        serde_json::from_str(response_line.trim_end()).map_err(|_| "invalid broker response")?;
    if response.prompt_id != request.prompt_id {
        return Err("broker response does not match prompt");
    }
    if response.status != ResponseStatus::Answered {
        return Err("request was not answered");
    }
    response.value.ok_or("broker returned no answer")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn classifies_common_git_and_ssh_prompts() {
        assert!(matches!(
            classify_prompt("Username for 'https://example.test':"),
            PromptKind::Username
        ));
        assert!(matches!(
            classify_prompt("Enter passphrase for key '/home/test/.ssh/id_ed25519':"),
            PromptKind::Secret
        ));
        assert!(matches!(
            classify_prompt("Are you sure you want to continue connecting (yes/no)?"),
            PromptKind::Confirmation
        ));
        assert!(matches!(
            classify_prompt("Custom prompt:"),
            PromptKind::Unknown
        ));
    }

    #[test]
    fn exchanges_one_answer_without_echoing_it_in_diagnostics() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut request)
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(request.trim()).unwrap();
            assert_eq!(value["token"], "one-time-token");
            stream
                .write_all(b"{\"promptId\":\"prompt-1\",\"status\":\"answered\",\"value\":\"secret answer\"}\n")
                .unwrap();
        });
        let request = AskpassRequest {
            token: "one-time-token",
            operation_id: "op-1",
            prompt_id: "prompt-1",
            prompt: "Password:",
            kind: PromptKind::Secret,
        };

        assert_eq!(exchange(address, &request).unwrap(), "secret answer");
        server.join().unwrap();
    }

    #[test]
    fn treats_cancelled_response_as_failure() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut ignored = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut ignored)
                .unwrap();
            stream
                .write_all(b"{\"promptId\":\"prompt-1\",\"status\":\"cancelled\"}\n")
                .unwrap();
        });
        let request = AskpassRequest {
            token: "one-time-token",
            operation_id: "op-1",
            prompt_id: "prompt-1",
            prompt: "Password:",
            kind: PromptKind::Secret,
        };

        assert_eq!(exchange(address, &request), Err("request was not answered"));
        server.join().unwrap();
    }
}
