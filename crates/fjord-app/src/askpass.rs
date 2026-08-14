use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fjord_domain::{GitAuthPrompt, GitAuthPromptKind};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use uuid::Uuid;

pub const AUTH_PROMPT_EVENT: &str = "fjord-auth-prompt";

const DEFAULT_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// Separates a bulk operation's id from the repository it is running for.
const SUB_OPERATION_SEPARATOR: &str = "::";

/// Id for one repository inside a bulk operation. Each gets its own session —
/// its own token, its own prompts, its own repository name — while staying
/// cancellable through the parent operation.
pub fn sub_operation_id(operation_id: &str, repo_id: &str) -> String {
    format!("{operation_id}{SUB_OPERATION_SEPARATOR}{repo_id}")
}

type PromptNotifier = Arc<dyn Fn(GitAuthPrompt) + Send + Sync>;

pub struct AskpassBroker {
    address: SocketAddr,
    inner: Arc<BrokerInner>,
    listener_task: JoinHandle<()>,
}

struct BrokerInner {
    sessions: Mutex<HashMap<String, OperationSession>>,
    pending: Mutex<HashMap<PromptKey, oneshot::Sender<PendingAnswer>>>,
    notifier: PromptNotifier,
    session_ttl: Duration,
    prompt_timeout: Duration,
}

struct OperationSession {
    token: String,
    expires_at: Instant,
    used_prompt_ids: HashSet<String>,
    cancelled: bool,
    repository_name: Option<String>,
    operation_kind: Option<String>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct PromptKey {
    operation_id: String,
    prompt_id: String,
}

pub struct AskpassSession {
    address: SocketAddr,
    operation_id: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskpassRequest {
    token: String,
    operation_id: String,
    prompt_id: String,
    prompt: String,
    kind: GitAuthPromptKind,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AskpassStatus {
    Answered,
    Cancelled,
    TimedOut,
    OperationCancelled,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskpassResponse {
    prompt_id: String,
    status: AskpassStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

enum PendingAnswer {
    Status(AskpassStatus),
    Answered(String),
}

impl AskpassBroker {
    pub async fn start(
        notifier: impl Fn(GitAuthPrompt) + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        Self::start_with_timeouts(notifier, DEFAULT_SESSION_TTL, DEFAULT_PROMPT_TIMEOUT).await
    }

    async fn start_with_timeouts(
        notifier: impl Fn(GitAuthPrompt) + Send + Sync + 'static,
        session_ttl: Duration,
        prompt_timeout: Duration,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        debug_assert_eq!(address.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        let inner = Arc::new(BrokerInner {
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            notifier: Arc::new(notifier),
            session_ttl,
            prompt_timeout,
        });
        let listener_inner = inner.clone();
        let listener_task = tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = listener.accept().await else {
                    break;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let connection_inner = listener_inner.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, connection_inner).await {
                        tracing::debug!(error = %error, "askpass broker rejected request");
                    }
                });
            }
        });

        Ok(Self {
            address,
            inner,
            listener_task,
        })
    }

    pub fn begin_operation(
        &self,
        operation_id: impl Into<String>,
        repository_name: Option<String>,
        operation_kind: Option<String>,
    ) -> AskpassSession {
        let operation_id = operation_id.into();
        self.finish_operation(&operation_id);
        // UUID v4 is generated from the operating system's CSPRNG. Combining
        // two UUIDs gives the bearer token 244 random bits after version bits.
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.inner
            .sessions
            .lock()
            .expect("askpass sessions lock should not be poisoned")
            .insert(
                operation_id.clone(),
                OperationSession {
                    token: token.clone(),
                    expires_at: Instant::now() + self.inner.session_ttl,
                    used_prompt_ids: HashSet::new(),
                    cancelled: false,
                    repository_name,
                    operation_kind,
                },
            );
        AskpassSession {
            address: self.address,
            operation_id,
            token,
        }
    }

    pub fn answer(&self, operation_id: &str, prompt_id: &str, value: String) -> bool {
        let key = PromptKey::new(operation_id, prompt_id);
        let sender = self
            .inner
            .pending
            .lock()
            .expect("askpass pending lock should not be poisoned")
            .remove(&key);
        sender.is_some_and(|sender| sender.send(PendingAnswer::Answered(value)).is_ok())
    }

    pub fn cancel_prompt(&self, operation_id: &str, prompt_id: &str) -> bool {
        self.resolve_prompt(operation_id, prompt_id, AskpassStatus::Cancelled)
    }

    /// Cancels the operation and every sub-operation started under it, so
    /// cancelling a bulk run also releases the per-repository prompts.
    pub fn cancel_operation(&self, operation_id: &str) {
        for id in self.operation_tree(operation_id) {
            if let Some(session) = self
                .inner
                .sessions
                .lock()
                .expect("askpass sessions lock should not be poisoned")
                .get_mut(&id)
            {
                session.cancelled = true;
            }
            self.resolve_operation(&id, AskpassStatus::OperationCancelled);
        }
    }

    pub fn finish_operation(&self, operation_id: &str) {
        for id in self.operation_tree(operation_id) {
            self.inner
                .sessions
                .lock()
                .expect("askpass sessions lock should not be poisoned")
                .remove(&id);
            self.resolve_operation(&id, AskpassStatus::OperationCancelled);
        }
    }

    /// The operation itself plus any live sub-operation of it.
    fn operation_tree(&self, operation_id: &str) -> Vec<String> {
        let prefix = format!("{operation_id}{SUB_OPERATION_SEPARATOR}");
        let mut ids = vec![operation_id.to_string()];
        ids.extend(
            self.inner
                .sessions
                .lock()
                .expect("askpass sessions lock should not be poisoned")
                .keys()
                .filter(|id| id.starts_with(&prefix))
                .cloned(),
        );
        ids
    }

    fn resolve_prompt(&self, operation_id: &str, prompt_id: &str, status: AskpassStatus) -> bool {
        self.inner
            .pending
            .lock()
            .expect("askpass pending lock should not be poisoned")
            .remove(&PromptKey::new(operation_id, prompt_id))
            .is_some_and(|sender| sender.send(PendingAnswer::Status(status)).is_ok())
    }

    fn resolve_operation(&self, operation_id: &str, status: AskpassStatus) {
        let senders = {
            let mut pending = self
                .inner
                .pending
                .lock()
                .expect("askpass pending lock should not be poisoned");
            let keys = pending
                .keys()
                .filter(|key| key.operation_id == operation_id)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| pending.remove(&key))
                .collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(PendingAnswer::Status(status));
        }
    }
}

impl Drop for AskpassBroker {
    fn drop(&mut self) {
        self.listener_task.abort();
    }
}

impl AskpassSession {
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

impl PromptKey {
    fn new(operation_id: &str, prompt_id: &str) -> Self {
        Self {
            operation_id: operation_id.to_string(),
            prompt_id: prompt_id.to_string(),
        }
    }
}

async fn handle_connection(stream: TcpStream, inner: Arc<BrokerInner>) -> std::io::Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader).take(MAX_REQUEST_BYTES);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).await? == 0 {
        return Ok(());
    }
    let request: AskpassRequest = serde_json::from_str(request_line.trim_end())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let prompt_id = request.prompt_id.clone();
    let prompt_key = PromptKey::new(&request.operation_id, &request.prompt_id);
    let pending = register_prompt(&inner, request);
    let response = match pending {
        Ok(receiver) => match tokio::time::timeout(inner.prompt_timeout, receiver).await {
            Ok(Ok(PendingAnswer::Answered(value))) => AskpassResponse {
                prompt_id,
                status: AskpassStatus::Answered,
                value: Some(value),
            },
            Ok(Ok(PendingAnswer::Status(status))) => AskpassResponse {
                prompt_id,
                status,
                value: None,
            },
            Ok(Err(_)) => AskpassResponse {
                prompt_id,
                status: AskpassStatus::OperationCancelled,
                value: None,
            },
            Err(_) => {
                inner
                    .pending
                    .lock()
                    .expect("askpass pending lock should not be poisoned")
                    .remove(&prompt_key);
                AskpassResponse {
                    prompt_id,
                    status: AskpassStatus::TimedOut,
                    value: None,
                }
            }
        },
        Err(status) => AskpassResponse {
            prompt_id,
            status,
            value: None,
        },
    };
    let mut encoded = serde_json::to_vec(&response)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.shutdown().await
}

fn register_prompt(
    inner: &Arc<BrokerInner>,
    request: AskpassRequest,
) -> Result<oneshot::Receiver<PendingAnswer>, AskpassStatus> {
    let (repository_name, operation_kind) = {
        let mut sessions = inner
            .sessions
            .lock()
            .expect("askpass sessions lock should not be poisoned");
        let Some(session) = sessions.get_mut(&request.operation_id) else {
            return Err(AskpassStatus::OperationCancelled);
        };
        if session.expires_at <= Instant::now() || !tokens_equal(&session.token, &request.token) {
            return Err(AskpassStatus::OperationCancelled);
        }
        if session.cancelled {
            return Err(AskpassStatus::OperationCancelled);
        }
        if !session.used_prompt_ids.insert(request.prompt_id.clone()) {
            return Err(AskpassStatus::Cancelled);
        }
        (
            session.repository_name.clone(),
            session.operation_kind.clone(),
        )
    };

    let key = PromptKey::new(&request.operation_id, &request.prompt_id);
    let (sender, receiver) = oneshot::channel();
    inner
        .pending
        .lock()
        .expect("askpass pending lock should not be poisoned")
        .insert(key, sender);
    (inner.notifier)(GitAuthPrompt {
        operation_id: request.operation_id,
        prompt_id: request.prompt_id,
        prompt: request.prompt,
        kind: request.kind,
        repository_name,
        operation_kind,
    });
    Ok(receiver)
}

fn tokens_equal(expected: &str, actual: &str) -> bool {
    if expected.len() != actual.len() {
        return false;
    }
    expected
        .bytes()
        .zip(actual.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    async fn broker() -> (AskpassBroker, mpsc::UnboundedReceiver<GitAuthPrompt>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let broker = AskpassBroker::start(move |prompt| {
            let _ = sender.send(prompt);
        })
        .await
        .unwrap();
        (broker, receiver)
    }

    async fn send_request(session: &AskpassSession, prompt_id: &str) -> AskpassResponse {
        let mut stream = TcpStream::connect(session.address()).await.unwrap();
        let request = serde_json::json!({
            "token": session.token(),
            "operationId": session.operation_id(),
            "promptId": prompt_id,
            "prompt": "Password:",
            "kind": "secret"
        });
        stream
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let mut response = String::new();
        BufReader::new(stream)
            .read_line(&mut response)
            .await
            .unwrap();
        serde_json::from_str(response.trim()).unwrap()
    }

    #[tokio::test]
    async fn rejects_invalid_token() {
        let (broker, _events) = broker().await;
        let session = broker.begin_operation("op-1", None, None);
        let invalid = AskpassSession {
            address: session.address,
            operation_id: session.operation_id.clone(),
            token: "invalid".into(),
        };

        let response = send_request(&invalid, "prompt-1").await;
        assert_eq!(response.status, AskpassStatus::OperationCancelled);
    }

    #[tokio::test]
    async fn rejects_expired_token() {
        let (sender, _events) = mpsc::unbounded_channel();
        let broker = AskpassBroker::start_with_timeouts(
            move |prompt| {
                let _ = sender.send(prompt);
            },
            Duration::from_millis(1),
            DEFAULT_PROMPT_TIMEOUT,
        )
        .await
        .unwrap();
        let session = broker.begin_operation("op-1", None, None);
        tokio::time::sleep(Duration::from_millis(5)).await;

        let response = send_request(&session, "prompt-1").await;
        assert_eq!(response.status, AskpassStatus::OperationCancelled);
    }

    #[tokio::test]
    async fn answers_concurrent_prompts_without_crossing_operations() {
        let (broker, mut events) = broker().await;
        let first = broker.begin_operation("op-1", Some("one".into()), Some("fetch".into()));
        let second = broker.begin_operation("op-2", Some("two".into()), Some("push".into()));
        let first_request = send_request(&first, "prompt-1");
        let second_request = send_request(&second, "prompt-2");
        let requests = async {
            let first_event = events.recv().await.unwrap();
            let second_event = events.recv().await.unwrap();
            assert_ne!(first_event.operation_id, second_event.operation_id);
            assert!(broker.answer(
                &first_event.operation_id,
                &first_event.prompt_id,
                "first".into()
            ));
            assert!(broker.answer(
                &second_event.operation_id,
                &second_event.prompt_id,
                "second".into()
            ));
        };
        let (first_response, second_response, ()) =
            tokio::join!(first_request, second_request, requests);
        let values = [
            first_response.value.unwrap(),
            second_response.value.unwrap(),
        ];
        assert!(values.contains(&"first".to_string()));
        assert!(values.contains(&"second".to_string()));
    }

    /// During a bulk run each repository prompts under its own session, and
    /// cancelling the bulk operation has to release all of them.
    #[tokio::test]
    async fn cancelling_a_bulk_operation_releases_every_repository_prompt() {
        let (broker, mut events) = broker().await;
        let first_id = sub_operation_id("bulk-1", "repo-a");
        let second_id = sub_operation_id("bulk-1", "repo-b");
        let first = broker.begin_operation(
            first_id.clone(),
            Some("api-gateway".into()),
            Some("bulk-fetch".into()),
        );
        let second = broker.begin_operation(
            second_id.clone(),
            Some("billing".into()),
            Some("bulk-fetch".into()),
        );

        let first_request = send_request(&first, "prompt-1");
        let second_request = send_request(&second, "prompt-2");
        let cancel = async {
            let first_event = events.recv().await.unwrap();
            let second_event = events.recv().await.unwrap();
            let names = [
                first_event.repository_name.clone().unwrap(),
                second_event.repository_name.clone().unwrap(),
            ];
            assert!(names.contains(&"api-gateway".to_string()));
            assert!(names.contains(&"billing".to_string()));
            assert_ne!(first_event.operation_id, second_event.operation_id);
            broker.cancel_operation("bulk-1");
        };

        let (first_response, second_response, ()) =
            tokio::join!(first_request, second_request, cancel);
        assert_eq!(
            first_response.status,
            AskpassStatus::OperationCancelled,
            "the parent cancel must reach every sub-operation"
        );
        assert_eq!(second_response.status, AskpassStatus::OperationCancelled);
    }

    #[tokio::test]
    async fn cancellation_releases_waiting_prompt() {
        let (broker, mut events) = broker().await;
        let session = broker.begin_operation("op-1", None, None);
        let request = send_request(&session, "prompt-1");
        let cancel = async {
            events.recv().await.unwrap();
            broker.cancel_operation("op-1");
        };

        let (response, ()) = tokio::join!(request, cancel);
        assert_eq!(response.status, AskpassStatus::OperationCancelled);
    }

    #[tokio::test]
    async fn prompt_id_and_answer_are_single_use() {
        let (broker, mut events) = broker().await;
        let session = broker.begin_operation("op-1", None, None);
        let request = send_request(&session, "prompt-1");
        let answer = async {
            let event = events.recv().await.unwrap();
            assert!(broker.answer(&event.operation_id, &event.prompt_id, "secret".into()));
            assert!(!broker.answer(&event.operation_id, &event.prompt_id, "other".into()));
        };
        let (response, ()) = tokio::join!(request, answer);
        assert_eq!(response.value.as_deref(), Some("secret"));

        let reused = send_request(&session, "prompt-1").await;
        assert_eq!(reused.status, AskpassStatus::Cancelled);
    }
}
