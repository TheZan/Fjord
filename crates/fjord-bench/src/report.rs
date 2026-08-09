//! Machine-readable benchmark results (docs/tasks.md P6-03,
//! specs/performance.md §10).
//!
//! The harness printed `key=value` lines meant for a human reading a terminal.
//! Regression reporting needs the opposite: a document a workflow can diff
//! against a previous run without parsing prose. Both are emitted — the text
//! output is what a developer reads, the JSON is what CI compares.
//!
//! Every record carries the environment that produced it, because a duration is
//! meaningless without one. The harness refuses to compare across platforms
//! (specs/performance.md §1), and it can only do that if each result says where
//! it came from.

use std::fmt::Write as _;
use std::fs;
use std::path::Path;

/// Bumped when the document's shape changes, so a consumer can reject records
/// it does not understand instead of silently misreading them.
pub const SCHEMA_VERSION: u32 = 1;

/// Where a report should be written. `--json -` means stdout, which is what a
/// workflow step captures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destination {
    Stdout,
    File(std::path::PathBuf),
}

impl Destination {
    pub fn parse(value: &str) -> Self {
        if value == "-" {
            Self::Stdout
        } else {
            Self::File(std::path::PathBuf::from(value))
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Metric {
    pub name: String,
    pub value: f64,
    pub unit: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BudgetResult {
    pub name: String,
    pub budget_ms: f64,
    pub actual_ms: f64,
    pub ok: bool,
}

#[derive(Debug, Clone)]
pub struct Report {
    scenario: String,
    fixture_kind: String,
    fixture_hash: String,
    fixture_generated: bool,
    metrics: Vec<Metric>,
    budgets: Vec<BudgetResult>,
}

impl Report {
    pub fn new(scenario: impl Into<String>, fixture_kind: &str, fixture_hash: &str) -> Self {
        Self {
            scenario: scenario.into(),
            fixture_kind: fixture_kind.to_string(),
            fixture_hash: fixture_hash.to_string(),
            fixture_generated: false,
            metrics: Vec::new(),
            budgets: Vec::new(),
        }
    }

    pub fn fixture_generated(&mut self, generated: bool) -> &mut Self {
        self.fixture_generated = generated;
        self
    }

    /// A duration in milliseconds — the unit every budget is expressed in.
    pub fn ms(&mut self, name: &str, value: f64) -> &mut Self {
        self.metrics.push(Metric {
            name: name.to_string(),
            value,
            unit: "ms",
        });
        self
    }

    /// A cardinality (commits returned, repositories, search hits). Recorded so
    /// a timing can be sanity-checked against what the run actually did: a
    /// suspiciously fast `log` usually means it returned nothing.
    pub fn count(&mut self, name: &str, value: u64) -> &mut Self {
        self.metrics.push(Metric {
            name: name.to_string(),
            value: value as f64,
            unit: "count",
        });
        self
    }

    pub fn budget(&mut self, result: BudgetResult) -> &mut Self {
        self.budgets.push(result);
        self
    }

    pub fn failed_budgets(&self) -> Vec<&BudgetResult> {
        self.budgets.iter().filter(|budget| !budget.ok).collect()
    }

    pub fn to_json(&self) -> String {
        let environment = Environment::detect();
        let mut out = String::new();
        out.push('{');
        let _ = write!(out, "\"schemaVersion\":{SCHEMA_VERSION}");
        let _ = write!(out, ",\"scenario\":{}", json_string(&self.scenario));
        let _ = write!(
            out,
            ",\"fixture\":{{\"kind\":{},\"hash\":{},\"generated\":{}}}",
            json_string(&self.fixture_kind),
            json_string(&self.fixture_hash),
            self.fixture_generated
        );
        let _ = write!(out, ",\"environment\":{}", environment.to_json());

        out.push_str(",\"metrics\":{");
        for (index, metric) in self.metrics.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let _ = write!(
                out,
                "{}:{{\"value\":{},\"unit\":{}}}",
                json_string(&metric.name),
                json_number(metric.value),
                json_string(metric.unit)
            );
        }
        out.push('}');

        out.push_str(",\"budgets\":[");
        for (index, budget) in self.budgets.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let _ = write!(
                out,
                "{{\"name\":{},\"budgetMs\":{},\"actualMs\":{},\"ok\":{}}}",
                json_string(&budget.name),
                json_number(budget.budget_ms),
                json_number(budget.actual_ms),
                budget.ok
            );
        }
        out.push(']');

        out.push('}');
        out
    }

    pub fn emit(&self, destination: &Destination) -> Result<(), String> {
        let document = self.to_json();
        match destination {
            Destination::Stdout => {
                println!("{document}");
                Ok(())
            }
            Destination::File(path) => {
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                write_document(path, &document)
            }
        }
    }
}

fn write_document(path: &Path, document: &str) -> Result<(), String> {
    fs::write(path, format!("{document}\n")).map_err(|e| e.to_string())
}

/// Where a measurement came from. Two results are only comparable when these
/// match, which is why they travel with every record rather than being noted
/// in a commit message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Environment {
    pub os: String,
    pub arch: String,
    pub cpu: String,
    pub profile: &'static str,
}

impl Environment {
    pub fn detect() -> Self {
        Self {
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            cpu: cpu_model().unwrap_or_else(|| "unknown".to_string()),
            // Release numbers are the only ones worth comparing; recording the
            // profile is what stops a debug run from being read as a regression.
            profile: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
        }
    }

    fn to_json(&self) -> String {
        format!(
            "{{\"os\":{},\"arch\":{},\"cpu\":{},\"profile\":{}}}",
            json_string(&self.os),
            json_string(&self.arch),
            json_string(&self.cpu),
            json_string(self.profile)
        )
    }
}

/// Best-effort CPU model, per platform, without pulling in a system-info crate
/// for one string. An unknown model degrades the record; it never fails a run.
fn cpu_model() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("PROCESSOR_IDENTIFIER")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    #[cfg(target_os = "linux")]
    {
        let contents = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        contents.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key.trim() == "model name").then(|| value.trim().to_string())
        })
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()?;
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (!value.is_empty()).then_some(value)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

/// Finite values only. A `NaN` or infinity would serialize to a bare token that
/// is not valid JSON, and a consumer would fail on the whole document rather
/// than on the one broken metric.
fn json_number(value: f64) -> String {
    if value.is_finite() {
        format!("{value:.3}")
    } else {
        "null".to_string()
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample() -> Report {
        let mut report = Report::new("log-first-page", "repo", "054061d688589db6");
        report
            .fixture_generated(true)
            .ms("open", 0.455)
            .ms("status", 3.535)
            .ms("log", 9.746)
            .count("log_commits", 200)
            .budget(BudgetResult {
                name: "log".into(),
                budget_ms: 150.0,
                actual_ms: 9.746,
                ok: true,
            });
        report
    }

    /// The document has to be parseable and to carry everything a regression
    /// comparison needs: which scenario, which fixture, which machine.
    #[test]
    fn the_document_carries_scenario_fixture_and_environment() {
        let json = sample().to_json();

        assert!(json.starts_with('{') && json.ends_with('}'));
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"scenario\":\"log-first-page\""));
        assert!(json.contains("\"hash\":\"054061d688589db6\""));
        assert!(json.contains("\"generated\":true"));
        assert!(json.contains("\"os\":"));
        assert!(json.contains("\"arch\":"));
        assert!(json.contains("\"cpu\":"));
        assert!(json.contains(if cfg!(debug_assertions) {
            "\"profile\":\"debug\""
        } else {
            "\"profile\":\"release\""
        }));
    }

    #[test]
    fn metrics_carry_their_unit() {
        let json = sample().to_json();

        assert!(json.contains("\"log\":{\"value\":9.746,\"unit\":\"ms\"}"));
        assert!(json.contains("\"log_commits\":{\"value\":200.000,\"unit\":\"count\"}"));
    }

    #[test]
    fn budgets_record_both_sides_of_the_comparison() {
        let json = sample().to_json();

        assert!(
            json.contains("{\"name\":\"log\",\"budgetMs\":150.000,\"actualMs\":9.746,\"ok\":true}")
        );
    }

    /// A failing run is exactly the run whose numbers matter most, so the
    /// document must still be well-formed and must say what failed.
    #[test]
    fn a_failing_budget_is_reported_rather_than_omitted() {
        let mut report = Report::new("log-first-page", "repo", "abc");
        report.ms("log", 400.0).budget(BudgetResult {
            name: "log".into(),
            budget_ms: 150.0,
            actual_ms: 400.0,
            ok: false,
        });

        assert_eq!(report.failed_budgets().len(), 1);
        assert!(report.to_json().contains("\"ok\":false"));
    }

    #[test]
    fn non_finite_metrics_do_not_produce_invalid_json() {
        let mut report = Report::new("broken", "repo", "abc");
        report.ms("divided_by_zero", f64::INFINITY);

        assert!(report.to_json().contains("\"value\":null"));
    }

    #[test]
    fn writing_to_a_file_creates_missing_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("result.json");

        sample().emit(&Destination::File(path.clone())).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.ends_with('\n'), "records append cleanly");
        assert!(written.contains("\"scenario\":\"log-first-page\""));
    }

    #[test]
    fn a_dash_destination_means_stdout() {
        assert_eq!(Destination::parse("-"), Destination::Stdout);
        assert_eq!(
            Destination::parse("out.json"),
            Destination::File(std::path::PathBuf::from("out.json"))
        );
    }
}
