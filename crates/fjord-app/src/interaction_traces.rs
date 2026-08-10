//! Local-only end-to-end interaction telemetry (performance spec §3).
//!
//! The WebView supplies an opaque interaction id. This module deliberately
//! accepts no request arguments beyond that id and the compile-time Tauri
//! command name, so paths, repository names, and diff content cannot enter a
//! trace accidentally.

use std::collections::{BTreeMap, VecDeque};
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use fjord_domain::{InteractionSpan, InteractionTrace};
use tauri::ipc::{CommandArg, CommandItem, InvokeBody, InvokeError};
use tauri::{Runtime, State};

use crate::state::AppState;

pub const DEFAULT_TRACE_CAPACITY: usize = 512;
const MAX_INTERACTION_ID_LEN: usize = 96;

pub struct InteractionTraceCollector {
    enabled: AtomicBool,
    capacity: usize,
    traces: Mutex<VecDeque<InteractionTrace>>,
}

impl InteractionTraceCollector {
    pub fn new(enabled: bool) -> Self {
        Self::with_capacity(enabled, DEFAULT_TRACE_CAPACITY)
    }

    fn with_capacity(enabled: bool, capacity: usize) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            capacity: capacity.max(1),
            traces: Mutex::new(VecDeque::with_capacity(capacity.max(1))),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            self.traces.lock().unwrap().clear();
        }
    }

    pub fn drain(&self) -> Vec<InteractionTrace> {
        self.traces.lock().unwrap().drain(..).collect()
    }

    fn start(
        self: &Arc<Self>,
        interaction_id: Option<&str>,
        operation: &'static str,
    ) -> InteractionGuard {
        if !self.enabled() {
            return InteractionGuard::disabled();
        }
        let Some(interaction_id) = interaction_id.and_then(sanitize_interaction_id) else {
            return InteractionGuard::disabled();
        };
        let span = tracing::info_span!(
            "interaction",
            interaction_id = %interaction_id,
            phase = "handler",
            operation
        );
        InteractionGuard {
            active: Some(ActiveInteractionSpan {
                collector: self.clone(),
                interaction_id,
                operation,
                started_at: Instant::now(),
                span,
            }),
        }
    }

    fn record(&self, interaction_id: String, span: InteractionSpan) {
        if !self.enabled() {
            return;
        }
        let mut traces = self.traces.lock().unwrap();
        if let Some(trace) = traces
            .iter_mut()
            .find(|trace| trace.interaction_id == interaction_id)
        {
            trace.spans.push(span);
            return;
        }
        if traces.len() == self.capacity {
            traces.pop_front();
        }
        traces.push_back(InteractionTrace {
            interaction_id,
            spans: vec![span],
        });
    }
}

/// Managed application state plus an interaction guard. Replacing Tauri's
/// plain `State<AppState>` with this one extractor instruments every command
/// without adding a required argument to the JSON contract.
pub struct TracedState<'r, T = AppState> {
    state: State<'r, AppState>,
    _interaction: InteractionGuard,
    _state_type: PhantomData<T>,
}

impl std::ops::Deref for TracedState<'_, AppState> {
    type Target = AppState;

    fn deref(&self) -> &Self::Target {
        self.state.inner()
    }
}

impl<'r, 'de: 'r, R: Runtime> CommandArg<'de, R> for TracedState<'r, AppState> {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let Some(state) = command.message.state_ref().try_get::<AppState>() else {
            return Err(InvokeError::from_error(std::io::Error::other(format!(
                "AppState is not managed for command {}",
                command.name
            ))));
        };
        let interaction_id = match command.message.payload() {
            InvokeBody::Json(payload) => payload
                .get("interactionId")
                .and_then(|value| value.as_str()),
            InvokeBody::Raw(_) => None,
        };
        let interaction = state.interaction_traces.start(interaction_id, command.name);
        Ok(Self {
            state,
            _interaction: interaction,
            _state_type: PhantomData,
        })
    }
}

struct ActiveInteractionSpan {
    collector: Arc<InteractionTraceCollector>,
    interaction_id: String,
    operation: &'static str,
    started_at: Instant,
    span: tracing::Span,
}

/// A command argument extracted by Tauri without adding a required JSON field.
/// Its lifetime brackets the complete async handler, including service/adapter
/// work, and `Drop` records a duration from Rust's monotonic clock.
pub struct InteractionGuard {
    active: Option<ActiveInteractionSpan>,
}

impl InteractionGuard {
    fn disabled() -> Self {
        Self { active: None }
    }
}

impl Drop for InteractionGuard {
    fn drop(&mut self) {
        let Some(active) = self.active.take() else {
            return;
        };
        let duration_micros = active
            .started_at
            .elapsed()
            .as_micros()
            .min(u64::MAX as u128) as u64;
        active.span.in_scope(|| {
            tracing::debug!(duration_micros, "interaction handler completed");
        });
        active.collector.record(
            active.interaction_id,
            InteractionSpan {
                phase: "handler".to_string(),
                operation: active.operation.to_string(),
                duration_micros,
                counts: BTreeMap::new(),
            },
        );
    }
}

fn sanitize_interaction_id(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > MAX_INTERACTION_ID_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'-' | b'_'))
    {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::hint::black_box;
    use std::time::Duration;

    #[test]
    fn ring_buffer_keeps_only_the_newest_interactions() {
        let collector = Arc::new(InteractionTraceCollector::with_capacity(true, 2));
        for id in ["session:1", "session:2", "session:3"] {
            drop(collector.start(Some(id), "get_repo_status"));
        }

        let traces = collector.drain();
        assert_eq!(traces.len(), 2);
        assert_eq!(traces[0].interaction_id, "session:2");
        assert_eq!(traces[1].interaction_id, "session:3");
    }

    #[test]
    fn spans_for_one_interaction_are_grouped() {
        let collector = Arc::new(InteractionTraceCollector::with_capacity(true, 2));
        drop(collector.start(Some("session:1"), "get_branches"));
        drop(collector.start(Some("session:1"), "get_commit_log"));

        let traces = collector.drain();
        assert_eq!(traces.len(), 1);
        assert_eq!(traces[0].spans.len(), 2);
    }

    #[test]
    fn unsafe_ids_and_request_data_cannot_enter_a_trace() {
        let collector = Arc::new(InteractionTraceCollector::with_capacity(true, 2));
        drop(collector.start(Some("C:/users/alice/secret-repo"), "get_file_diff"));
        drop(collector.start(Some("session:1"), "get_file_diff"));

        let serialized = serde_json::to_string(&collector.drain()).unwrap();
        assert!(!serialized.contains("alice"));
        assert!(!serialized.contains("secret-repo"));
        assert!(!serialized.contains("path"));
        assert!(serialized.contains("session:1"));
        assert!(serialized.contains("get_file_diff"));
    }

    #[test]
    fn disabling_collection_clears_and_stops_the_buffer() {
        let collector = Arc::new(InteractionTraceCollector::with_capacity(true, 2));
        drop(collector.start(Some("session:1"), "get_repo_status"));
        collector.set_enabled(false);
        drop(collector.start(Some("session:2"), "get_repo_status"));
        assert!(collector.drain().is_empty());
    }

    // Run with:
    // cargo test --release -p fjord-app interaction_trace_overhead -- --ignored --nocapture
    #[test]
    #[ignore = "release-only performance benchmark"]
    fn interaction_trace_overhead_is_below_one_percent() {
        const BATCHES: usize = 10;
        const ITERATIONS_PER_BATCH: usize = 40;
        const WORK: u64 = 4_500_000;
        let collector = Arc::new(InteractionTraceCollector::new(true));

        fn representative_work(seed: u64, work: u64) -> u64 {
            let mut value = seed | 1;
            for index in 0..work {
                value = value.rotate_left(7) ^ index.wrapping_mul(0x9e37_79b9);
                black_box(value);
            }
            value
        }

        fn measure_batch(
            collector: &Arc<InteractionTraceCollector>,
            traced: bool,
            batch: usize,
        ) -> Duration {
            let started = Instant::now();
            for iteration in 0..ITERATIONS_PER_BATCH {
                let id = format!("bench:{batch}:{iteration}");
                let guard = traced.then(|| collector.start(Some(&id), "get_repo_status"));
                black_box(representative_work(iteration as u64, WORK));
                drop(guard);
            }
            started.elapsed()
        }

        // Warm instruction/data caches before either timed side, then alternate
        // order so CPU boost and thermal drift do not consistently favor one.
        black_box(representative_work(1, WORK));
        let mut baseline = Duration::ZERO;
        let mut traced = Duration::ZERO;
        for batch in 0..BATCHES {
            if batch % 2 == 0 {
                baseline += measure_batch(&collector, false, batch);
                traced += measure_batch(&collector, true, batch);
            } else {
                traced += measure_batch(&collector, true, batch);
                baseline += measure_batch(&collector, false, batch);
            }
        }
        let percent = (traced.as_secs_f64() / baseline.as_secs_f64() - 1.0) * 100.0;
        println!("baseline={baseline:?} traced={traced:?} overhead={percent:.3}%");
        assert!(baseline > Duration::ZERO);
        assert!(
            percent < 1.0,
            "interaction trace overhead was {percent:.3}%"
        );
    }
}
