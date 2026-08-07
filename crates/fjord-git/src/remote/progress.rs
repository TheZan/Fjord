//! Parsing and throttling of the progress Git writes while a transfer runs.
//! Git reports phases on stderr and overwrites them with `\r`, so the runner
//! feeds every line here and the backend forwards only what the UI can absorb.

use std::time::{Duration, Instant};

use fjord_ports::GitProgress;

const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(75);

#[derive(Default)]
pub(super) struct ProgressThrottle {
    last_emit: Option<Instant>,
    last_message: Option<String>,
}

impl ProgressThrottle {
    pub(super) fn should_emit(&mut self, progress: &GitProgress) -> bool {
        let now = Instant::now();
        let phase_changed = progress.message != self.last_message;
        let finished = progress.total > 0 && progress.completed >= progress.total;
        let interval_elapsed = self
            .last_emit
            .is_none_or(|last| now.duration_since(last) >= PROGRESS_EMIT_INTERVAL);
        if phase_changed || finished || interval_elapsed {
            self.last_emit = Some(now);
            self.last_message.clone_from(&progress.message);
            true
        } else {
            false
        }
    }
}

pub(super) fn parse_progress(line: &str) -> Option<GitProgress> {
    let line = line.trim().strip_prefix("remote: ").unwrap_or(line.trim());
    let phase = [
        "Enumerating objects",
        "Counting objects",
        "Compressing objects",
        "Receiving objects",
        "Resolving deltas",
        "Writing objects",
        "Total",
    ]
    .into_iter()
    .find(|phase| line.starts_with(phase))?;

    if let Some(open) = line.find('(') {
        if let Some(close) = line[open + 1..].find(')') {
            if let Some((completed, total)) = line[open + 1..open + 1 + close].split_once('/') {
                if let (Ok(completed), Ok(total)) = (completed.parse(), total.parse()) {
                    return Some(GitProgress {
                        completed,
                        total,
                        message: Some(phase.to_string()),
                    });
                }
            }
        }
    }

    let percent = line.find('%')?;
    let digits = line[..percent]
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    digits
        .parse::<u32>()
        .ok()
        .filter(|value| *value <= 100)
        .map(|completed| GitProgress {
            completed,
            total: 100,
            message: Some(phase.to_string()),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_counts_and_phases() {
        assert_eq!(
            parse_progress("Receiving objects:  42% (21/50)"),
            Some(GitProgress {
                completed: 21,
                total: 50,
                message: Some("Receiving objects".into()),
            })
        );
        assert_eq!(parse_progress("remote: done"), None);
    }

    #[test]
    fn carriage_return_updates_and_unknown_output_stay_harmless() {
        assert_eq!(
            parse_progress("remote: Counting objects:  50% (5/10)\r"),
            Some(GitProgress {
                completed: 5,
                total: 10,
                message: Some("Counting objects".into()),
            })
        );
        assert_eq!(parse_progress("hint: something unexpected"), None);
    }

    #[test]
    fn throttle_always_emits_phase_changes_and_the_final_update() {
        let mut throttle = ProgressThrottle::default();
        let progress = |completed, total, message: &str| GitProgress {
            completed,
            total,
            message: Some(message.into()),
        };

        assert!(throttle.should_emit(&progress(1, 100, "Receiving objects")));
        assert!(!throttle.should_emit(&progress(2, 100, "Receiving objects")));
        assert!(throttle.should_emit(&progress(1, 100, "Resolving deltas")));
        assert!(throttle.should_emit(&progress(100, 100, "Resolving deltas")));
    }
}
