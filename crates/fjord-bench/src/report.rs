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
pub const SCHEMA_VERSION: u32 = 2;

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
    pub distribution: Option<Distribution>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Distribution {
    pub samples: usize,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

impl Distribution {
    pub fn from_samples(samples: &[f64]) -> Self {
        assert!(
            !samples.is_empty(),
            "a distribution needs at least one sample"
        );
        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        let percentile = |percent: f64| {
            let rank = (percent * sorted.len() as f64).ceil() as usize;
            sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
        };
        Self {
            samples: sorted.len(),
            p50: percentile(0.50),
            p95: percentile(0.95),
            max: *sorted.last().expect("non-empty samples"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BudgetResult {
    pub name: String,
    pub budget_ms: f64,
    pub actual_ms: f64,
    pub ok: bool,
}

/// Whether the OS file cache was cold when the run started.
///
/// The harness cannot clear the cache itself — doing so needs privileges and a
/// different mechanism on every platform — so this is what the operator asserts,
/// and `Unknown` is the honest default. A run that *might* have been warm is
/// never recorded as cold: on a filesystem-heavy fixture the difference is the
/// measurement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheState {
    Cold,
    Warm,
    #[default]
    Unknown,
}

impl CacheState {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cold" => Ok(Self::Cold),
            "warm" => Ok(Self::Warm),
            "unknown" => Ok(Self::Unknown),
            other => Err(format!(
                "unknown cache state '{other}'; expected cold, warm, or unknown"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Cold => "cold",
            Self::Warm => "warm",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Report {
    scenario: String,
    fixture_kind: String,
    fixture_hash: String,
    fixture_generated: bool,
    cache_state: CacheState,
    metrics: Vec<Metric>,
    budgets: Vec<BudgetResult>,
    warmups: usize,
    repetitions: usize,
}

impl Report {
    pub fn new(scenario: impl Into<String>, fixture_kind: &str, fixture_hash: &str) -> Self {
        Self {
            scenario: scenario.into(),
            fixture_kind: fixture_kind.to_string(),
            fixture_hash: fixture_hash.to_string(),
            fixture_generated: false,
            cache_state: CacheState::default(),
            metrics: Vec::new(),
            budgets: Vec::new(),
            warmups: 0,
            repetitions: 1,
        }
    }

    pub fn fixture_generated(&mut self, generated: bool) -> &mut Self {
        self.fixture_generated = generated;
        self
    }

    pub fn cache_state(&mut self, state: CacheState) -> &mut Self {
        self.cache_state = state;
        self
    }

    pub fn sampling(&mut self, warmups: usize, repetitions: usize) -> &mut Self {
        self.warmups = warmups;
        self.repetitions = repetitions;
        self
    }

    /// A duration in milliseconds — the unit every budget is expressed in.
    pub fn ms(&mut self, name: &str, value: f64) -> &mut Self {
        self.metrics.push(Metric {
            name: name.to_string(),
            value,
            unit: "ms",
            distribution: None,
        });
        self
    }

    /// Records the methodology distribution. `value` deliberately aliases
    /// P95 so existing comparison consumers and every budget use the ratified
    /// statistic rather than quietly falling back to one run.
    pub fn ms_distribution(&mut self, name: &str, samples: &[f64]) -> Distribution {
        let distribution = Distribution::from_samples(samples);
        self.metrics.push(Metric {
            name: name.to_string(),
            value: distribution.p95,
            unit: "ms",
            distribution: Some(distribution.clone()),
        });
        distribution
    }

    /// A cardinality (commits returned, repositories, search hits). Recorded so
    /// a timing can be sanity-checked against what the run actually did: a
    /// suspiciously fast `log` usually means it returned nothing.
    pub fn count(&mut self, name: &str, value: u64) -> &mut Self {
        self.metrics.push(Metric {
            name: name.to_string(),
            value: value as f64,
            unit: "count",
            distribution: None,
        });
        self
    }

    /// A scalar reported in an explicit non-duration unit, used by resource
    /// scenarios such as idle CPU and resident memory.
    pub fn metric(&mut self, name: &str, value: f64, unit: &'static str) -> &mut Self {
        self.metrics.push(Metric {
            name: name.to_string(),
            value,
            unit,
            distribution: None,
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
        let _ = write!(
            out,
            ",\"environment\":{},\"cacheState\":{}",
            environment.to_json(),
            json_string(self.cache_state.as_str())
        );
        let _ = write!(
            out,
            ",\"sampling\":{{\"warmups\":{},\"repetitions\":{}}}",
            self.warmups, self.repetitions
        );

        out.push_str(",\"metrics\":{");
        for (index, metric) in self.metrics.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let _ = write!(
                out,
                "{}:{{\"value\":{},\"unit\":{}",
                json_string(&metric.name),
                json_number(metric.value),
                json_string(metric.unit)
            );
            if let Some(distribution) = &metric.distribution {
                let _ = write!(
                    out,
                    ",\"samples\":{},\"p50\":{},\"p95\":{},\"max\":{}",
                    distribution.samples,
                    json_number(distribution.p50),
                    json_number(distribution.p95),
                    json_number(distribution.max)
                );
            }
            out.push('}');
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

    /// Prints per-metric deltas against a recorded baseline, refusing when the
    /// two runs are not comparable.
    pub fn compare_against(&self, baseline: &Recorded) -> Result<(), String> {
        self.comparability()
            .require_comparable(&baseline.comparability)?;

        println!("--- compared with the recorded baseline ---");
        for metric in self.metrics.iter().filter(|metric| metric.unit != "count") {
            let Some(previous) = baseline
                .metrics
                .iter()
                .find(|candidate| candidate.name == metric.name)
            else {
                println!("{}: no baseline", metric.name);
                continue;
            };
            if previous.unit != metric.unit {
                println!(
                    "{}: unit changed from {} to {}; no delta",
                    metric.name, previous.unit, metric.unit
                );
                continue;
            }
            let delta = metric.value - previous.value;
            let percent = if previous.value > 0.0 {
                delta / previous.value * 100.0
            } else {
                0.0
            };
            println!(
                "{}: {:.3} {} vs {:.3} {} ({:+.1}%)",
                metric.name, metric.value, metric.unit, previous.value, previous.unit, percent
            );
        }
        Ok(())
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

/// The identity two results must share before their durations mean anything
/// side by side (specs/performance.md §1: "results from different platforms are
/// never compared; the harness refuses to").
///
/// This is the whole reason the environment travels with each record. Without
/// it, a Windows cold-cache run and a Linux warm-cache run look like a 4×
/// regression rather than two different measurements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comparability {
    pub scenario: String,
    pub fixture_hash: String,
    pub os: String,
    pub arch: String,
    pub profile: &'static str,
    pub cache_state: CacheState,
    pub warmups: usize,
    pub repetitions: usize,
}

impl Report {
    pub fn comparability(&self) -> Comparability {
        let environment = Environment::detect();
        Comparability {
            scenario: self.scenario.clone(),
            fixture_hash: self.fixture_hash.clone(),
            os: environment.os,
            arch: environment.arch,
            profile: environment.profile,
            cache_state: self.cache_state,
            warmups: self.warmups,
            repetitions: self.repetitions,
        }
    }
}

/// A previously recorded run, read back for `--compare`.
pub struct Recorded {
    pub comparability: Comparability,
    pub metrics: Vec<Metric>,
}

/// Reads a record written by an earlier run.
///
/// Only reading needs a JSON parser: the document shape is ours, and writing it
/// by hand is covered by tests. A stored record from a newer schema is rejected
/// rather than partially understood.
pub fn read_recorded(path: &Path) -> Result<Recorded, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not a benchmark record: {error}", path.display()))?;

    let version = value["schemaVersion"].as_u64().unwrap_or_default();
    if version != u64::from(SCHEMA_VERSION) {
        return Err(format!(
            "{} uses record schema {version}, this build writes {SCHEMA_VERSION}; \
             re-run the baseline rather than comparing across schemas",
            path.display()
        ));
    }

    let string = |value: &serde_json::Value| value.as_str().unwrap_or_default().to_string();
    let profile = match value["environment"]["profile"].as_str() {
        Some("release") => "release",
        Some("debug") => "debug",
        other => return Err(format!("unknown profile in {}: {other:?}", path.display())),
    };

    let metrics = value["metrics"]
        .as_object()
        .map(|entries| {
            entries
                .iter()
                .map(|(name, metric)| Metric {
                    name: name.clone(),
                    value: metric["value"].as_f64().unwrap_or(f64::NAN),
                    unit: match metric["unit"].as_str() {
                        Some("count") => "count",
                        Some("s") => "s",
                        Some("%core") => "%core",
                        Some("MiB") => "MiB",
                        _ => "ms",
                    },
                    distribution: None,
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(Recorded {
        comparability: Comparability {
            scenario: string(&value["scenario"]),
            fixture_hash: string(&value["fixture"]["hash"]),
            os: string(&value["environment"]["os"]),
            arch: string(&value["environment"]["arch"]),
            profile,
            cache_state: CacheState::parse(value["cacheState"].as_str().unwrap_or("unknown"))?,
            warmups: value["sampling"]["warmups"].as_u64().unwrap_or_default() as usize,
            repetitions: value["sampling"]["repetitions"]
                .as_u64()
                .unwrap_or_default() as usize,
        },
        metrics,
    })
}

impl Comparability {
    /// Every reason these two results cannot be compared. Empty means they can.
    pub fn mismatches(&self, other: &Self) -> Vec<String> {
        let mut reasons = Vec::new();
        let mut check = |field: &str, left: &str, right: &str| {
            if left != right {
                reasons.push(format!("{field}: {left} vs {right}"));
            }
        };
        check("scenario", &self.scenario, &other.scenario);
        check("fixture", &self.fixture_hash, &other.fixture_hash);
        check("os", &self.os, &other.os);
        check("arch", &self.arch, &other.arch);
        check("profile", self.profile, other.profile);
        check(
            "cache state",
            self.cache_state.as_str(),
            other.cache_state.as_str(),
        );
        check(
            "warmups",
            &self.warmups.to_string(),
            &other.warmups.to_string(),
        );
        check(
            "repetitions",
            &self.repetitions.to_string(),
            &other.repetitions.to_string(),
        );
        reasons
    }

    /// Refuses rather than warns. A comparison nobody can trust is worse than
    /// no comparison, because it will be quoted.
    pub fn require_comparable(&self, other: &Self) -> Result<(), String> {
        let reasons = self.mismatches(other);
        if reasons.is_empty() {
            return Ok(());
        }
        Err(format!(
            "these results are not comparable ({}). Compare runs of the same \
             scenario, fixture, platform, profile, cache state, and sampling settings.",
            reasons.join("; ")
        ))
    }
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
            .metric("resident_memory", 24.0, "MiB")
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
        assert!(json.contains("\"schemaVersion\":2"));
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
        assert!(json.contains("\"resident_memory\":{\"value\":24.000,\"unit\":\"MiB\"}"));
    }

    #[test]
    fn distributions_use_nearest_rank_and_serialize_every_statistic() {
        let samples = (1..=20).map(f64::from).collect::<Vec<_>>();
        let mut report = Report::new("status", "working-tree", "abc");
        report.sampling(3, 20);
        let distribution = report.ms_distribution("status", &samples);

        assert_eq!(distribution.p50, 10.0);
        assert_eq!(distribution.p95, 19.0);
        assert_eq!(distribution.max, 20.0);
        let json = report.to_json();
        assert!(json.contains("\"sampling\":{\"warmups\":3,\"repetitions\":20}"));
        assert!(json.contains(
            "\"status\":{\"value\":19.000,\"unit\":\"ms\",\"samples\":20,\"p50\":10.000,\"p95\":19.000,\"max\":20.000}"
        ));
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
    fn an_unknown_cache_state_is_the_default_and_is_recorded() {
        assert!(sample().to_json().contains("\"cacheState\":\"unknown\""));

        let mut cold = sample();
        cold.cache_state(CacheState::Cold);
        assert!(cold.to_json().contains("\"cacheState\":\"cold\""));

        assert!(CacheState::parse("sometimes").is_err());
    }

    /// The point of recording the environment: a Windows cold-cache run and a
    /// Linux warm-cache run are two measurements, not a regression.
    #[test]
    fn results_from_different_conditions_are_refused() {
        let warm = sample().comparability();
        let mut cold_report = sample();
        cold_report.cache_state(CacheState::Cold);
        let cold = cold_report.comparability();

        let error = warm
            .require_comparable(&cold)
            .expect_err("a cold and a warm run are not comparable");
        assert!(error.contains("cache state"), "unexpected error: {error}");

        let other_platform = Comparability {
            os: "linux".into(),
            ..warm.clone()
        };
        assert!(warm.require_comparable(&other_platform).is_err());

        let other_fixture = Comparability {
            fixture_hash: "different".into(),
            ..warm.clone()
        };
        assert!(warm.require_comparable(&other_fixture).is_err());
    }

    #[test]
    fn identical_conditions_compare() {
        let one = sample().comparability();
        let two = sample().comparability();
        assert_eq!(one.mismatches(&two), Vec::<String>::new());
        assert!(one.require_comparable(&two).is_ok());
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
