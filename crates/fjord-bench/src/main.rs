#![allow(linker_messages)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fjord_db::{SqliteSettingsStore, SqliteWorkspaceStore};
use fjord_fs::{RepoEventWatcher, RepositoryWatchScope};
use fjord_git::{LocalGitBackend, SystemGitEnvironmentProvider, SystemGitRemoteBackend};
use fjord_ports::{
    DiffWindowOptions, GitBackend, IdeLauncher, LaunchError, RepoPath, WorkspaceStore,
};
use fjord_services::{RepoService, WorkspaceService};
use git2::{Repository, RepositoryInitOptions, Signature};

/// `RepoService` needs an `IdeLauncher`; the benchmark never launches one.
struct NoopIdeLauncher;

#[async_trait::async_trait]
impl IdeLauncher for NoopIdeLauncher {
    async fn open(&self, _path: &Path, _ide: Option<&str>) -> Result<(), LaunchError> {
        Ok(())
    }
    async fn open_terminal(&self, _path: &Path) -> Result<(), LaunchError> {
        Ok(())
    }
}

mod fixtures;
mod generate;
mod manifest;
mod report;

use manifest::{Fixture, Preparation};
use report::{BudgetResult, CacheState, Destination, Distribution, Report};

#[derive(Debug)]
struct Args {
    repo: PathBuf,
    commits: usize,
    files: usize,
    workspace_repos: usize,
    log_limit: u32,
    budget_log_ms: Option<f64>,
    budget_live_refresh_ms: Option<f64>,
    budget_cached_dashboard_ms: Option<f64>,
    force: bool,
    profile_open: bool,
    scenario: Option<String>,
    json: Option<Destination>,
    fixture: Option<String>,
    budget_status_ms: Option<f64>,
    budget_refs_ms: Option<f64>,
    budget_diff_ms: Option<f64>,
    cache_state: CacheState,
    compare: Option<PathBuf>,
    warmups: usize,
    repetitions: usize,
    idle_seconds: u64,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            repo: PathBuf::from("target/fjord-bench/synthetic-repo"),
            commits: 200,
            files: 50,
            workspace_repos: 1,
            log_limit: 50,
            budget_log_ms: None,
            budget_live_refresh_ms: None,
            budget_cached_dashboard_ms: None,
            force: false,
            profile_open: false,
            scenario: None,
            json: None,
            fixture: None,
            budget_status_ms: None,
            budget_refs_ms: None,
            budget_diff_ms: None,
            cache_state: CacheState::Unknown,
            compare: None,
            warmups: 3,
            repetitions: 20,
            idle_seconds: 60,
        }
    }
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args::default();
    let mut iter = env::args().skip(1);

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--repo" => args.repo = PathBuf::from(next_value(&mut iter, "--repo")?),
            "--commits" => {
                args.commits = parse_usize(next_value(&mut iter, "--commits")?, "--commits")?
            }
            "--files" => args.files = parse_usize(next_value(&mut iter, "--files")?, "--files")?,
            "--workspace-repos" => {
                args.workspace_repos = parse_usize(
                    next_value(&mut iter, "--workspace-repos")?,
                    "--workspace-repos",
                )?
            }
            "--log-limit" => {
                args.log_limit = parse_u32(next_value(&mut iter, "--log-limit")?, "--log-limit")?
            }
            "--budget-log-ms" => {
                args.budget_log_ms = Some(parse_f64(
                    next_value(&mut iter, "--budget-log-ms")?,
                    "--budget-log-ms",
                )?)
            }
            "--budget-live-refresh-ms" => {
                args.budget_live_refresh_ms = Some(parse_f64(
                    next_value(&mut iter, "--budget-live-refresh-ms")?,
                    "--budget-live-refresh-ms",
                )?)
            }
            "--budget-cached-dashboard-ms" => {
                args.budget_cached_dashboard_ms = Some(parse_f64(
                    next_value(&mut iter, "--budget-cached-dashboard-ms")?,
                    "--budget-cached-dashboard-ms",
                )?)
            }
            "--fixture" => args.fixture = Some(next_value(&mut iter, "--fixture")?),
            "--budget-status-ms" => {
                args.budget_status_ms = Some(parse_f64(
                    next_value(&mut iter, "--budget-status-ms")?,
                    "--budget-status-ms",
                )?)
            }
            "--budget-refs-ms" => {
                args.budget_refs_ms = Some(parse_f64(
                    next_value(&mut iter, "--budget-refs-ms")?,
                    "--budget-refs-ms",
                )?)
            }
            "--budget-diff-ms" => {
                args.budget_diff_ms = Some(parse_f64(
                    next_value(&mut iter, "--budget-diff-ms")?,
                    "--budget-diff-ms",
                )?)
            }
            "--compare" => args.compare = Some(PathBuf::from(next_value(&mut iter, "--compare")?)),
            "--warmups" => {
                args.warmups = parse_usize(next_value(&mut iter, "--warmups")?, "--warmups")?
            }
            "--repetitions" => {
                args.repetitions =
                    parse_usize(next_value(&mut iter, "--repetitions")?, "--repetitions")?
            }
            "--idle-seconds" => {
                args.idle_seconds =
                    parse_usize(next_value(&mut iter, "--idle-seconds")?, "--idle-seconds")? as u64
            }
            "--cache-state" => {
                args.cache_state = CacheState::parse(&next_value(&mut iter, "--cache-state")?)?
            }
            "--scenario" => args.scenario = Some(next_value(&mut iter, "--scenario")?),
            "--json" => {
                args.json = Some(Destination::parse(&next_value(&mut iter, "--json")?));
            }
            "--force" => args.force = true,
            "--profile-open" => args.profile_open = true,
            "--help" | "-h" => return Err(usage()),
            other => return Err(format!("unknown argument: {other}\n\n{}", usage())),
        }
    }

    if args.commits == 0 {
        return Err("--commits must be at least 1".to_string());
    }
    if args.files == 0 {
        return Err("--files must be at least 1".to_string());
    }
    if args.workspace_repos == 0 {
        return Err("--workspace-repos must be at least 1".to_string());
    }
    if args.repetitions == 0 {
        return Err("--repetitions must be at least 1".to_string());
    }
    if args.idle_seconds == 0 {
        return Err("--idle-seconds must be at least 1".to_string());
    }
    let has_budget = [
        args.budget_log_ms,
        args.budget_live_refresh_ms,
        args.budget_cached_dashboard_ms,
        args.budget_status_ms,
        args.budget_refs_ms,
        args.budget_diff_ms,
    ]
    .iter()
    .any(Option::is_some);
    if has_budget && args.repetitions < 20 {
        return Err(
            "budget checks require --repetitions 20 or greater; shorter runs are exploratory"
                .to_string(),
        );
    }

    Ok(args)
}

fn next_value(iter: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    iter.next()
        .ok_or_else(|| format!("{flag} requires a value\n\n{}", usage()))
}

fn parse_usize(value: String, flag: &str) -> Result<usize, String> {
    value
        .parse()
        .map_err(|_| format!("{flag} must be a positive integer"))
}

fn parse_u32(value: String, flag: &str) -> Result<u32, String> {
    value
        .parse()
        .map_err(|_| format!("{flag} must be a positive integer"))
}

fn parse_f64(value: String, flag: &str) -> Result<f64, String> {
    let parsed = value
        .parse()
        .map_err(|_| format!("{flag} must be a positive number"))?;
    if parsed <= 0.0 {
        return Err(format!("{flag} must be greater than zero"));
    }
    Ok(parsed)
}

fn usage() -> String {
    format!(
        "Usage: cargo run --release -p fjord-bench -- [OPTIONS]\n\n\
         Named fixtures (specs/performance.md §2):\n  \
           --fixture NAME        one of: {}\n  \
           --files N             override the fixture's file count\n\n\
         Ad-hoc runs:\n  \
           --repo PATH --commits N --files N [--workspace-repos N] [--log-limit N]\n\n\
         Reporting:\n  \
           --scenario NAME       scenario label recorded in the result\n  \
           --json PATH|-         write a machine-readable record\n  \
           --cache-state STATE   cold | warm | unknown (operator-asserted)\n\n\
           --warmups N           discarded warmup runs (default: 3)\n  \
           --repetitions N       measured runs for P50/P95/max (default: 20)\n\n\
           --idle-seconds N      resource-sampling window (default: 60)\n\n\
         Budgets (fail the run when exceeded):\n  \
           --budget-status-ms N  --budget-log-ms N  --budget-refs-ms N  --budget-diff-ms N\n  \
           --budget-live-refresh-ms N  --budget-cached-dashboard-ms N\n\n\
         Other:\n  \
           --force               regenerate the fixture even if it matches\n  \
           --profile-open        profile repository-open reads against --repo",
        fixtures::NAMES.join(", ")
    )
}

/// What a single synthetic repository is, for reuse purposes.
fn repo_fixture(commits: usize, files: usize) -> Fixture {
    Fixture::new("repo")
        .with("commits", commits)
        .with("files", files)
}

/// What a synthetic workspace is. The per-repository parameters are included
/// because changing them invalidates every repository under the root.
fn workspace_fixture(repos: usize, commits: usize, files: usize) -> Fixture {
    Fixture::new("workspace")
        .with("repos", repos)
        .with("commits_per_repo", commits)
        .with("files_per_repo", files)
}

fn generate_repo(path: &Path, commits: usize, files: usize) -> Result<(), String> {
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repo = Repository::init_opts(path, &options).map_err(|e| e.message().to_string())?;
    let mut config = repo.config().map_err(|e| e.message().to_string())?;
    config
        .set_str("user.name", "Fjord Bench")
        .map_err(|e| e.message().to_string())?;
    config
        .set_str("user.email", "bench@example.com")
        .map_err(|e| e.message().to_string())?;

    // The manifest and marker are written after the last commit, so without
    // this they would sit in the working tree as untracked files and every
    // fixture would report `dirty_count=2`. Excluding them keeps the generated
    // repository clean, which is what the recorded baselines measured.
    manifest::exclude_from_git(path)?;

    for file_index in 0..files {
        write_bench_file(path, file_index, 0)?;
    }
    commit_all(&repo, "seed synthetic repository")?;

    for commit_index in 1..commits {
        write_bench_file(path, commit_index % files, commit_index)?;
        commit_all(&repo, &format!("synthetic commit {commit_index}"))?;
    }

    // Written last: an interrupted generation must leave a directory that
    // regenerates, not one that claims to be a complete fixture.
    manifest::write(path, &repo_fixture(commits, files))
}

fn write_bench_file(repo: &Path, file_index: usize, commit_index: usize) -> Result<(), String> {
    let path = repo.join(format!("file-{file_index:04}.txt"));
    fs::write(
        path,
        format!("file {file_index}\nsynthetic revision {commit_index}\n"),
    )
    .map_err(|e| e.to_string())
}

fn commit_all(repo: &Repository, message: &str) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| e.message().to_string())?;
    let signature =
        Signature::now("Fjord Bench", "bench@example.com").map_err(|e| e.message().to_string())?;
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let parents = parent.iter().collect::<Vec<_>>();

    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parents,
    )
    .map(|_| ())
    .map_err(|e| e.message().to_string())
}

/// Times the exact set of reads the UI fires when a repository is opened,
/// first one at a time and then all at once. Run against a real checkout
/// (`--repo <path> --profile-open`) — synthetic repos have a handful of refs
/// and hide everything that makes a large repository slow.
///
/// The concurrent total is the interesting number: if it tracks the *sum*
/// of the individual timings rather than the slowest one, the reads are
/// serializing behind a lock somewhere rather than actually overlapping.
async fn run_open_profile(args: Args) -> Result<(), String> {
    if !args.repo.join(".git").exists() {
        return Err(format!("{} is not a git repository", args.repo.display()));
    }

    let backend = Arc::new(LocalGitBackend::new());
    let repo = RepoPath::new(args.repo.clone());

    println!("repo={}", args.repo.display());

    let open_start = Instant::now();
    Repository::open(&args.repo).map_err(|e| e.message().to_string())?;
    println!("open_ms={:.1}", ms(open_start.elapsed()));

    let start = Instant::now();
    let status = backend.status(&repo).await.map_err(|e| e.to_string())?;
    let status_ms = ms(start.elapsed());

    let start = Instant::now();
    let branches = backend.branches(&repo).await.map_err(|e| e.to_string())?;
    let branches_ms = ms(start.elapsed());

    let start = Instant::now();
    let tags = backend.tags(&repo).await.map_err(|e| e.to_string())?;
    let tags_ms = ms(start.elapsed());

    let start = Instant::now();
    let log = backend
        .log(&repo, None, args.log_limit)
        .await
        .map_err(|e| e.to_string())?;
    let log_ms = ms(start.elapsed());

    let start = Instant::now();
    let changes = backend
        .working_changes(&repo)
        .await
        .map_err(|e| e.to_string())?;
    let changes_ms = ms(start.elapsed());

    println!("branches={} tags={}", branches.len(), tags.len());
    println!(
        "log_commits={} dirty={} working_files={}",
        log.commits.len(),
        status.dirty_count,
        changes.staged.len() + changes.unstaged.len()
    );
    println!("--- sequential ---");
    println!("status_ms={status_ms:.1}");
    println!("branches_ms={branches_ms:.1}");
    println!("tags_ms={tags_ms:.1}");
    println!("log_ms={log_ms:.1}");
    println!("working_changes_ms={changes_ms:.1}");
    let sum = status_ms + branches_ms + tags_ms + log_ms + changes_ms;
    let slowest = [status_ms, branches_ms, tags_ms, log_ms, changes_ms]
        .into_iter()
        .fold(0.0_f64, f64::max);
    println!("sum_ms={sum:.1}");

    // Same five reads, issued together the way the UI does on open.
    let concurrent_start = Instant::now();
    let (a, b, c, d, e) = tokio::join!(
        {
            let backend = backend.clone();
            let repo = repo.clone();
            async move { backend.status(&repo).await }
        },
        {
            let backend = backend.clone();
            let repo = repo.clone();
            async move { backend.branches(&repo).await }
        },
        {
            let backend = backend.clone();
            let repo = repo.clone();
            async move { backend.tags(&repo).await }
        },
        {
            let backend = backend.clone();
            let repo = repo.clone();
            let limit = args.log_limit;
            async move { backend.log(&repo, None, limit).await }
        },
        {
            let backend = backend.clone();
            let repo = repo.clone();
            async move { backend.working_changes(&repo).await }
        },
    );
    a.map_err(|e| e.to_string())?;
    b.map_err(|e| e.to_string())?;
    c.map_err(|e| e.to_string())?;
    d.map_err(|e| e.to_string())?;
    e.map_err(|e| e.to_string())?;
    let concurrent_ms = ms(concurrent_start.elapsed());

    println!("--- concurrent (as the UI opens a repo) ---");
    println!("concurrent_ms={concurrent_ms:.1}");
    println!("slowest_single_ms={slowest:.1}");
    println!(
        "verdict={}",
        if concurrent_ms > sum * 0.8 {
            "SERIALIZED (concurrent ≈ sum, reads are not overlapping)"
        } else {
            "overlapping"
        }
    );

    Ok(())
}

fn ms(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Records a budget comparison and prints the line the text output has always
/// carried. Failing is deliberately *not* this function's job: a run that
/// exceeds a budget is the run whose numbers matter most, so it has to finish
/// reporting before it fails (see `finish`).
fn check_budget(name: &str, actual_ms: f64, budget_ms: Option<f64>) -> Option<BudgetResult> {
    let budget_ms = budget_ms?;
    let ok = actual_ms <= budget_ms;
    println!(
        "budget_{name}_ms={budget_ms:.3} actual_{name}_ms={actual_ms:.3} budget_{name}_ok={ok}"
    );

    Some(BudgetResult {
        name: name.to_string(),
        budget_ms,
        actual_ms,
        ok,
    })
}

fn check_distribution_budget(
    name: &str,
    distribution: &Distribution,
    budget_ms: Option<f64>,
) -> Option<BudgetResult> {
    check_budget(name, distribution.p95, budget_ms)
}

/// Emits the machine-readable record, then fails if any budget was exceeded.
/// The order matters: a regression must be visible in the recorded result, not
/// only in a non-zero exit code.
fn finish(
    report: &Report,
    destination: Option<&Destination>,
    compare: Option<&Path>,
) -> Result<(), String> {
    // Compared before emitting, so a refusal names the reason rather than
    // leaving the operator to spot it in two files.
    if let Some(path) = compare {
        let baseline = report::read_recorded(path)?;
        report.compare_against(&baseline)?;
    }
    if let Some(destination) = destination {
        report.emit(destination)?;
    }

    let failed = report.failed_budgets();
    if failed.is_empty() {
        return Ok(());
    }

    Err(failed
        .iter()
        .map(|budget| {
            format!(
                "{} exceeded budget: {:.3} ms > {:.3} ms",
                budget.name, budget.actual_ms, budget.budget_ms
            )
        })
        .collect::<Vec<_>>()
        .join("; "))
}

/// Runs a named fixture from the catalogue: generate it if the parameters do
/// not already match what is on disk, then take the measurement it exists for.
async fn run_named_fixture(args: Args, name: &str) -> Result<(), String> {
    let plan = fixtures::plan(
        name,
        fixtures::Overrides {
            files: (args.files != Args::default().files).then_some(args.files),
            commits: (args.commits != Args::default().commits).then_some(args.commits),
            workspace_repos: (args.workspace_repos != Args::default().workspace_repos)
                .then_some(args.workspace_repos),
        },
    )?;

    let root = fixture_root(&args, plan.name);
    let generated = fixtures::materialize(&root, &plan, args.force)?;

    let mut record = Report::new(
        args.scenario.as_deref().unwrap_or(plan.name),
        plan.fixture.kind,
        &plan.fixture.hash(),
    );
    record
        .fixture_generated(generated)
        .cache_state(args.cache_state)
        .sampling(args.warmups, args.repetitions);

    println!("fixture={}", plan.name);
    println!("root={}", root.display());
    println!("generated={generated}");
    println!("fixture_hash={}", plan.fixture.hash());

    match plan.scenario {
        fixtures::Scenario::Status => measure_status(&root, &args, &mut record).await?,
        fixtures::Scenario::LogFirstPage => measure_log(&root, &args, &mut record).await?,
        fixtures::Scenario::RefsRead => measure_refs(&root, &args, &mut record).await?,
        fixtures::Scenario::FileDiff => measure_file_diff(&root, &args, &mut record).await?,
        fixtures::Scenario::WorkspaceDashboard => {
            if args.scenario.as_deref() == Some("idle-cost") {
                measure_idle_cost(&root, &plan, &args, &mut record).await?
            } else {
                measure_workspace_dashboard(&root, &plan, &args, &mut record).await?
            }
        }
    }

    finish(&record, args.json.as_ref(), args.compare.as_deref())
}

#[derive(Debug, Clone, Copy)]
struct ProcessSample {
    cpu_seconds: f64,
    rss_bytes: u64,
}

/// Models the application's steady tiered state without a WebView: 3 Hot and
/// 32 Warm repositories retain runtime handles and recursive watches; the
/// remaining repositories retain metadata-only watches and no handles.
async fn measure_idle_cost(
    root: &Path,
    plan: &fixtures::Plan,
    args: &Args,
    record: &mut Report,
) -> Result<(), String> {
    let fixtures::Build::Workspace { repos, .. } = plan.build else {
        return Err("the idle-cost scenario needs a workspace fixture".to_string());
    };
    let paths = (0..repos)
        .map(|index| RepoPath::new(root.join(format!("repo-{index:03}"))))
        .collect::<Vec<_>>();
    let resident_count = paths.len().min(35);
    fjord_git::set_resident_repositories(&paths[..resident_count]);

    let mut watchers = Vec::with_capacity(paths.len());
    for (index, repo) in paths.iter().enumerate() {
        let scope = if index < resident_count {
            RepositoryWatchScope::WorkingTree
        } else {
            RepositoryWatchScope::GitMetadata
        };
        watchers.push(
            RepoEventWatcher::watch_repository_with_scope(&repo.0, scope, |_| {})
                .map_err(|error| error.to_string())?,
        );
    }

    let backend = LocalGitBackend::new();
    for repo in paths.iter().take(resident_count) {
        backend
            .status(repo)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::time::sleep(Duration::from_secs(2)).await;

    let started = Instant::now();
    let before = process_sample()?;
    let deadline = started + Duration::from_secs(args.idle_seconds);
    let mut after = before;
    let mut max_rss_bytes = before.rss_bytes;
    let mut resource_samples = 1_u64;
    while Instant::now() < deadline {
        tokio::time::sleep(
            Duration::from_secs(1).min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
        after = process_sample()?;
        max_rss_bytes = max_rss_bytes.max(after.rss_bytes);
        resource_samples += 1;
    }
    let elapsed = started.elapsed().as_secs_f64();
    let cpu_percent_one_core =
        ((after.cpu_seconds - before.cpu_seconds).max(0.0) / elapsed) * 100.0;
    let rss_megabytes = max_rss_bytes as f64 / (1024.0 * 1024.0);

    println!("idle_window_seconds={:.3}", elapsed);
    println!("idle_cpu_percent_one_core={cpu_percent_one_core:.3}");
    println!("resident_memory_mb={rss_megabytes:.3}");
    println!("resource_samples={resource_samples}");
    println!("hot_repositories={}", resident_count.min(3));
    println!("warm_repositories={}", resident_count.saturating_sub(3));
    println!("cold_repositories={}", repos.saturating_sub(resident_count));

    record
        .metric("idle_window_seconds", elapsed, "s")
        .metric("idle_cpu_percent_one_core", cpu_percent_one_core, "%core")
        .metric("resident_memory", rss_megabytes, "MiB")
        .count("resource_samples", resource_samples)
        .count("hot_repositories", resident_count.min(3) as u64)
        .count("warm_repositories", resident_count.saturating_sub(3) as u64)
        .count(
            "cold_repositories",
            repos.saturating_sub(resident_count) as u64,
        )
        .count("recursive_watchers", resident_count as u64)
        .count(
            "metadata_watchers",
            repos.saturating_sub(resident_count) as u64,
        );

    drop(watchers);
    fjord_git::set_resident_repositories(&[]);
    Ok(())
}

#[cfg(target_os = "windows")]
fn process_sample() -> Result<ProcessSample, String> {
    let pid = std::process::id();
    let script = format!(
        "$p=Get-Process -Id {pid}; Write-Output ($p.TotalProcessorTime.TotalSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',' + $p.WorkingSet64)"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    parse_process_sample(String::from_utf8_lossy(&output.stdout).trim())
}

#[cfg(target_os = "linux")]
fn process_sample() -> Result<ProcessSample, String> {
    let stat = fs::read_to_string("/proc/self/stat").map_err(|error| error.to_string())?;
    let after_name = stat
        .rsplit_once(')')
        .map(|(_, fields)| fields.trim())
        .ok_or_else(|| "could not parse /proc/self/stat".to_string())?;
    let fields = after_name.split_whitespace().collect::<Vec<_>>();
    let ticks = fields
        .get(11)
        .and_then(|value| value.parse::<f64>().ok())
        .zip(fields.get(12).and_then(|value| value.parse::<f64>().ok()))
        .map(|(user, system)| user + system)
        .ok_or_else(|| "could not read process CPU ticks".to_string())?;
    let ticks_per_second = Command::new("getconf")
        .arg("CLK_TCK")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(100.0);
    let rss_pages = fields
        .get(21)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "could not read resident pages".to_string())?;
    let page_size = Command::new("getconf")
        .arg("PAGESIZE")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(4096);
    Ok(ProcessSample {
        cpu_seconds: ticks / ticks_per_second,
        rss_bytes: rss_pages.saturating_mul(page_size),
    })
}

#[cfg(target_os = "macos")]
fn process_sample() -> Result<ProcessSample, String> {
    let output = Command::new("ps")
        .args(["-o", "time=,rss=", "-p", &std::process::id().to_string()])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let fields = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let time = fields
        .first()
        .ok_or_else(|| "missing CPU time".to_string())?;
    let rss_kib = fields
        .get(1)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "missing resident memory".to_string())?;
    Ok(ProcessSample {
        cpu_seconds: parse_cpu_time(time)?,
        rss_bytes: rss_kib.saturating_mul(1024),
    })
}

#[cfg(target_os = "windows")]
fn parse_process_sample(value: &str) -> Result<ProcessSample, String> {
    let (cpu, rss) = value
        .split_once(',')
        .ok_or_else(|| format!("invalid process sample: {value}"))?;
    Ok(ProcessSample {
        cpu_seconds: cpu
            .trim()
            .parse::<f64>()
            .map_err(|error| error.to_string())?,
        rss_bytes: rss
            .trim()
            .parse::<u64>()
            .map_err(|error| error.to_string())?,
    })
}

#[cfg(target_os = "macos")]
fn parse_cpu_time(value: &str) -> Result<f64, String> {
    let parts = value.split(':').collect::<Vec<_>>();
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (
            0.0,
            minutes.parse::<f64>().map_err(|error| error.to_string())?,
            seconds.parse::<f64>().map_err(|error| error.to_string())?,
        ),
        [hours, minutes, seconds] => (
            hours.parse::<f64>().map_err(|error| error.to_string())?,
            minutes.parse::<f64>().map_err(|error| error.to_string())?,
            seconds.parse::<f64>().map_err(|error| error.to_string())?,
        ),
        _ => return Err(format!("invalid CPU time: {value}")),
    };
    Ok(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn is_measured_iteration(args: &Args, iteration: usize) -> bool {
    iteration >= args.warmups
}

fn sample_iterations(args: &Args) -> std::ops::Range<usize> {
    0..args.warmups.saturating_add(args.repetitions)
}

fn report_distribution(record: &mut Report, name: &str, samples: &[f64]) -> Distribution {
    let distribution = record.ms_distribution(name, samples);
    // Keep the old key as the P95 alias for scripts that consume key=value,
    // and make every statistic explicit alongside it.
    println!("{name}_ms={:.3}", distribution.p95);
    println!("{name}_p50_ms={:.3}", distribution.p50);
    println!("{name}_p95_ms={:.3}", distribution.p95);
    println!("{name}_max_ms={:.3}", distribution.max);
    distribution
}

/// The first bounded window of the 500k-line file plus the metadata-only path
/// for the file above the 10 MB display ceiling.
async fn measure_file_diff(root: &Path, args: &Args, record: &mut Report) -> Result<(), String> {
    let backend = LocalGitBackend::new();
    let repo = RepoPath::new(root.to_path_buf());
    let head = Repository::open(root)
        .map_err(|e| e.message().to_string())?
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|e| e.message().to_string())?
        .id()
        .to_string();

    let mut list_samples = Vec::with_capacity(args.repetitions);
    let mut diff_samples = Vec::with_capacity(args.repetitions);
    let mut files = Vec::new();
    let mut detail = None;
    let mut oversized = None;
    for iteration in sample_iterations(args) {
        let start = Instant::now();
        files = backend
            .diff(&repo, &head)
            .await
            .map_err(|e| e.to_string())?;
        let list_ms = ms(start.elapsed());

        let start = Instant::now();
        detail = Some(
            backend
                .file_diff_window(
                    &repo,
                    &head,
                    fixtures::DIFF_WINDOW_TARGET,
                    DiffWindowOptions {
                        offset: 0,
                        limit: 1_000,
                        max_file_bytes: 10 * 1024 * 1024,
                        whitespace: fjord_domain::DiffWhitespaceMode::Show,
                    },
                )
                .await
                .map_err(|e| e.to_string())?,
        );
        let diff_ms = ms(start.elapsed());
        oversized = Some(
            backend
                .file_diff_window(
                    &repo,
                    &head,
                    fixtures::DIFF_TARGET,
                    DiffWindowOptions {
                        offset: 0,
                        limit: 1_000,
                        max_file_bytes: 10 * 1024 * 1024,
                        whitespace: fjord_domain::DiffWhitespaceMode::Show,
                    },
                )
                .await
                .map_err(|e| e.to_string())?,
        );
        if is_measured_iteration(args, iteration) {
            list_samples.push(list_ms);
            diff_samples.push(diff_ms);
        }
    }
    let detail = detail.expect("at least one repetition");
    let oversized = oversized.expect("at least one repetition");

    let lines: usize = detail.hunks.iter().map(|hunk| hunk.lines.len()).sum();
    println!("changed_files={}", files.len());
    println!("diff_hunks={} diff_lines={lines}", detail.hunks.len());
    println!("diff_total_lines={}", detail.total_lines);
    println!(
        "diff_payload_bytes={}",
        serde_json::to_vec(&detail).unwrap().len()
    );
    println!("oversized_too_large={}", oversized.too_large);

    record
        .count("changed_files", files.len() as u64)
        .count("diff_hunks", detail.hunks.len() as u64)
        .count("diff_lines", lines as u64)
        .count("diff_total_lines", detail.total_lines as u64)
        .count(
            "diff_payload_bytes",
            serde_json::to_vec(&detail).unwrap().len() as u64,
        )
        .count("oversized_too_large", u64::from(oversized.too_large));
    report_distribution(record, "diff_list", &list_samples);
    let diff_distribution = report_distribution(record, "file_diff", &diff_samples);
    if let Some(budget) =
        check_distribution_budget("file_diff", &diff_distribution, args.budget_diff_ms)
    {
        record.budget(budget);
    }
    Ok(())
}

/// The workspace dashboard: a live status refresh across every repository, then
/// the cached read the UI actually renders from.
async fn measure_workspace_dashboard(
    root: &Path,
    plan: &fixtures::Plan,
    args: &Args,
    record: &mut Report,
) -> Result<(), String> {
    let fixtures::Build::Workspace { repos, .. } = plan.build else {
        return Err("the workspace scenario needs a workspace fixture".to_string());
    };

    let backend = Arc::new(LocalGitBackend::new());
    let pool = fjord_db::connect(Path::new(":memory:"))
        .await
        .map_err(|e| e.to_string())?;
    let settings = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let store = Arc::new(SqliteWorkspaceStore::new(pool));
    let workspace = store
        .create_workspace("Synthetic workspace")
        .await
        .map_err(|e| e.to_string())?;

    let mut registered = Vec::with_capacity(repos);
    for index in 0..repos {
        let name = format!("repo-{index:03}");
        let entry = store
            .add_repository(workspace.id, &name, root.join(&name).as_path())
            .await
            .map_err(|e| e.to_string())?;
        registered.push(entry);
    }

    let repo_service = RepoService::new(
        store.clone(),
        settings,
        backend.clone(),
        Arc::new(SystemGitRemoteBackend::new()),
        Arc::new(SystemGitEnvironmentProvider::new()),
        Arc::new(NoopIdeLauncher),
    );
    let workspace_service = WorkspaceService::new(store.clone(), backend.clone());
    repo_service
        .capture_repository_snapshot(registered[0].id)
        .await
        .map_err(|error| error.to_string())?;

    let cached_only = args.scenario.as_deref() == Some("workspace-render");
    if cached_only {
        for repo in &registered {
            let status = backend
                .status(&RepoPath::new(repo.path.clone()))
                .await
                .map_err(|error| error.to_string())?;
            store
                .upsert_repo_status(repo.id, &status)
                .await
                .map_err(|error| error.to_string())?;
        }
    }

    let mut live_samples = Vec::with_capacity(args.repetitions);
    let mut cached_samples = Vec::with_capacity(args.repetitions);
    let mut snapshot_samples = Vec::with_capacity(args.repetitions);
    let mut health_samples = Vec::with_capacity(args.repetitions);
    let mut dashboard = Vec::new();
    let mut health = Vec::new();
    for iteration in sample_iterations(args) {
        let live_refresh_ms = if cached_only {
            0.0
        } else {
            let start = Instant::now();
            for repo in &registered {
                let status = backend
                    .status(&RepoPath::new(repo.path.clone()))
                    .await
                    .map_err(|e| e.to_string())?;
                store
                    .upsert_repo_status(repo.id, &status)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            ms(start.elapsed())
        };

        let start = Instant::now();
        dashboard = store
            .list_workspace_status(workspace.id)
            .await
            .map_err(|e| e.to_string())?;
        let cached_dashboard_ms = ms(start.elapsed());

        let start = Instant::now();
        health = workspace_service
            .get_workspace_health(workspace.id)
            .await
            .map_err(|error| error.to_string())?;
        let workspace_health_ms = ms(start.elapsed());

        // Backend contribution to SLO-4. The frontend hydrates this one row
        // into its existing query cache before mounting the repository view.
        let start = Instant::now();
        let snapshot = repo_service
            .load_repository_snapshot(registered[0].id)
            .await
            .map_err(|error| error.to_string())?;
        let repo_snapshot_load_ms = ms(start.elapsed());
        if snapshot.is_none() {
            return Err("the representative repository snapshot disappeared".to_string());
        }
        if is_measured_iteration(args, iteration) {
            if !cached_only {
                live_samples.push(live_refresh_ms);
            }
            cached_samples.push(cached_dashboard_ms);
            health_samples.push(workspace_health_ms);
            snapshot_samples.push(repo_snapshot_load_ms);
        }
    }

    println!("workspace_repos={repos}");
    println!("dashboard_rows={}", dashboard.len());
    println!("health_rows={}", health.len());

    record
        .count("workspace_repos", repos as u64)
        .count("dashboard_rows", dashboard.len() as u64)
        .count("health_rows", health.len() as u64);
    let live_distribution =
        (!cached_only).then(|| report_distribution(record, "live_refresh", &live_samples));
    let cached_distribution = report_distribution(record, "cached_dashboard", &cached_samples);
    report_distribution(record, "workspace_health", &health_samples);
    report_distribution(record, "repo_snapshot_load", &snapshot_samples);
    for budget in [
        live_distribution.as_ref().and_then(|distribution| {
            check_distribution_budget("live_refresh", distribution, args.budget_live_refresh_ms)
        }),
        check_distribution_budget(
            "cached_dashboard",
            &cached_distribution,
            args.budget_cached_dashboard_ms,
        ),
    ]
    .into_iter()
    .flatten()
    {
        record.budget(budget);
    }
    Ok(())
}

/// The read a repository view waits on: the first page of history (SLO-8).
async fn measure_log(root: &Path, args: &Args, record: &mut Report) -> Result<(), String> {
    let backend = LocalGitBackend::new();
    let repo = RepoPath::new(root.to_path_buf());
    let limit = if args.log_limit == Args::default().log_limit {
        // The page size the UI actually requests.
        30
    } else {
        args.log_limit
    };

    let mut log_samples = Vec::with_capacity(args.repetitions);
    let mut page_10_samples = Vec::with_capacity(args.repetitions);
    let mut first_page = None;
    let mut page_10 = None;
    for iteration in sample_iterations(args) {
        let start = Instant::now();
        let current_first = backend
            .log(&repo, None, limit)
            .await
            .map_err(|e| e.to_string())?;
        let log_ms = ms(start.elapsed());

        let mut cursor = current_first.next_cursor.clone();
        for _ in 2..10 {
            let page = backend
                .log(&repo, cursor, limit)
                .await
                .map_err(|e| e.to_string())?;
            cursor = page.next_cursor;
        }
        let page_10_start = Instant::now();
        let current_page_10 = backend
            .log(&repo, cursor, limit)
            .await
            .map_err(|e| e.to_string())?;
        let page_10_ms = ms(page_10_start.elapsed());
        if is_measured_iteration(args, iteration) {
            log_samples.push(log_ms);
            page_10_samples.push(page_10_ms);
        }
        first_page = Some(current_first);
        page_10 = Some(current_page_10);
    }
    let first_page = first_page.expect("at least one repetition");
    let page_10 = page_10.expect("at least one repetition");

    println!("log_commits={}", first_page.commits.len());
    println!("log_page_10_commits={}", page_10.commits.len());

    record
        .count("log_commits", first_page.commits.len() as u64)
        .count("log_page_10_commits", page_10.commits.len() as u64);
    let log_distribution = report_distribution(record, "log", &log_samples);
    report_distribution(record, "log_page_10", &page_10_samples);
    if let Some(budget) = check_distribution_budget("log", &log_distribution, args.budget_log_ms) {
        record.budget(budget);
    }
    Ok(())
}

/// Branches and tags, as the repository tree loads them (SLO-16). Timed
/// together because the tree needs both before it can render.
async fn measure_refs(root: &Path, args: &Args, record: &mut Report) -> Result<(), String> {
    let backend = LocalGitBackend::new();
    let repo = RepoPath::new(root.to_path_buf());

    let mut samples = Vec::with_capacity(args.repetitions);
    let mut branches = Vec::new();
    let mut tags = Vec::new();
    for iteration in sample_iterations(args) {
        let start = Instant::now();
        branches = backend.branches(&repo).await.map_err(|e| e.to_string())?;
        tags = backend.tags(&repo).await.map_err(|e| e.to_string())?;
        let refs_ms = ms(start.elapsed());
        if is_measured_iteration(args, iteration) {
            samples.push(refs_ms);
        }
    }

    let remote_branches = branches.iter().filter(|branch| branch.is_remote).count();
    println!(
        "branches={} remote_branches={} tags={}",
        branches.len(),
        remote_branches,
        tags.len()
    );

    record
        .count("branches", branches.len() as u64)
        .count("remote_branches", remote_branches as u64)
        .count("tags", tags.len() as u64);
    let distribution = report_distribution(record, "refs", &samples);
    if let Some(budget) = check_distribution_budget("refs", &distribution, args.budget_refs_ms) {
        record.budget(budget);
    }
    Ok(())
}

/// Named fixtures live under a per-name directory so two fixtures never share a
/// root and invalidate each other. `--repo` selects the parent.
fn fixture_root(args: &Args, name: &str) -> PathBuf {
    if args.repo == Args::default().repo {
        PathBuf::from("target/fjord-bench").join(name)
    } else {
        args.repo.clone()
    }
}

async fn measure_status(root: &Path, args: &Args, record: &mut Report) -> Result<(), String> {
    let backend = LocalGitBackend::new();
    let repo = RepoPath::new(root.to_path_buf());

    let mut samples = Vec::with_capacity(args.repetitions);
    let mut status = None;
    for iteration in sample_iterations(args) {
        let start = Instant::now();
        let current = backend.status(&repo).await.map_err(|e| e.to_string())?;
        let status_ms = ms(start.elapsed());
        if is_measured_iteration(args, iteration) {
            samples.push(status_ms);
        }
        status = Some(current);
    }
    let status = status.expect("at least one repetition");

    println!(
        "branch={}",
        status.branch.unwrap_or_else(|| "(detached)".into())
    );
    println!("dirty_count={}", status.dirty_count);

    record.count("dirty_count", u64::from(status.dirty_count));
    let distribution = report_distribution(record, "status", &samples);
    if let Some(budget) = check_distribution_budget("status", &distribution, args.budget_status_ms)
    {
        record.budget(budget);
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args = parse_args()?;
    if let Some(name) = args.fixture.clone() {
        return run_named_fixture(args, &name).await;
    }
    if args.profile_open {
        return run_open_profile(args).await;
    }
    if args.workspace_repos > 1 {
        return run_workspace_benchmark(args).await;
    }

    let fixture = repo_fixture(args.commits, args.files);
    let preparation = manifest::prepare(&args.repo, &fixture, args.force)?;
    let should_generate = preparation == Preparation::Generate;

    if should_generate {
        generate_repo(&args.repo, args.commits, args.files)?;
    }

    let backend = LocalGitBackend::new();
    let repo = RepoPath::new(args.repo.clone());
    let mut open_samples = Vec::with_capacity(args.repetitions);
    let mut status_samples = Vec::with_capacity(args.repetitions);
    let mut log_samples = Vec::with_capacity(args.repetitions);
    let mut status = None;
    let mut log = None;
    for iteration in sample_iterations(&args) {
        let start = Instant::now();
        Repository::open(&args.repo).map_err(|e| e.message().to_string())?;
        let open_ms = ms(start.elapsed());

        let start = Instant::now();
        status = Some(backend.status(&repo).await.map_err(|e| e.to_string())?);
        let status_ms = ms(start.elapsed());

        let start = Instant::now();
        log = Some(
            backend
                .log(&repo, None, args.log_limit)
                .await
                .map_err(|e| e.to_string())?,
        );
        let log_ms = ms(start.elapsed());
        if is_measured_iteration(&args, iteration) {
            open_samples.push(open_ms);
            status_samples.push(status_ms);
            log_samples.push(log_ms);
        }
    }
    let status = status.expect("at least one repetition");
    let log = log.expect("at least one repetition");

    println!("repo={}", args.repo.display());
    println!("generated={should_generate}");
    println!("fixture={}", fixture.hash());
    println!("commits={}", args.commits);
    println!("files={}", args.files);
    println!(
        "branch={}",
        status.branch.unwrap_or_else(|| "(detached)".to_string())
    );
    println!("dirty_count={}", status.dirty_count);
    println!("has_conflict={}", status.has_conflict);
    println!("log_commits={}", log.commits.len());
    let mut record = Report::new(
        args.scenario.as_deref().unwrap_or("single-repo"),
        fixture.kind,
        &fixture.hash(),
    );
    record
        .fixture_generated(should_generate)
        .cache_state(args.cache_state)
        .sampling(args.warmups, args.repetitions)
        .count("commits", args.commits as u64)
        .count("files", args.files as u64)
        .count("log_commits", log.commits.len() as u64)
        .count("dirty_count", u64::from(status.dirty_count));
    report_distribution(&mut record, "open", &open_samples);
    report_distribution(&mut record, "status", &status_samples);
    let log_distribution = report_distribution(&mut record, "log", &log_samples);
    if let Some(budget) = check_distribution_budget("log", &log_distribution, args.budget_log_ms) {
        record.budget(budget);
    }

    finish(&record, args.json.as_ref(), args.compare.as_deref())
}

async fn run_workspace_benchmark(args: Args) -> Result<(), String> {
    let fixture = workspace_fixture(args.workspace_repos, args.commits, args.files);
    let generated = manifest::prepare(&args.repo, &fixture, args.force)? == Preparation::Generate;

    let backend = Arc::new(LocalGitBackend::new());
    let pool = fjord_db::connect(Path::new(":memory:"))
        .await
        .map_err(|e| e.to_string())?;
    let settings_store = Arc::new(SqliteSettingsStore::new(pool.clone()));
    let store = Arc::new(SqliteWorkspaceStore::new(pool));
    let workspace = store
        .create_workspace("Synthetic workspace")
        .await
        .map_err(|e| e.to_string())?;

    let generation_start = Instant::now();
    let repo_fixture = repo_fixture(args.commits, args.files);
    let mut repositories = Vec::new();
    for index in 0..args.workspace_repos {
        let repo_path = args.repo.join(format!("repo-{index:02}"));
        // The root was already cleared when the workspace parameters changed,
        // so a surviving repository here is one whose own manifest matches.
        if manifest::prepare(&repo_path, &repo_fixture, args.force)? == Preparation::Generate {
            generate_repo(&repo_path, args.commits, args.files)?;
        }

        let entry = store
            .add_repository(
                workspace.id,
                &format!("repo-{index:02}"),
                repo_path.as_path(),
            )
            .await
            .map_err(|e| e.to_string())?;
        repositories.push(entry);
    }
    let generation_elapsed = generation_start.elapsed();

    // Global search across every repo in the workspace (P4-13): a commit
    // query is the worst case — it forces a bounded `log` scan per repo.
    let remote_backend = Arc::new(SystemGitRemoteBackend::new());
    let repo_service = RepoService::new(
        store.clone(),
        settings_store,
        backend.clone(),
        remote_backend,
        Arc::new(SystemGitEnvironmentProvider::new()),
        Arc::new(NoopIdeLauncher),
    );
    let workspace_service = WorkspaceService::new(store.clone(), backend.clone());
    let mut live_samples = Vec::with_capacity(args.repetitions);
    let mut cached_samples = Vec::with_capacity(args.repetitions);
    let mut search_samples = Vec::with_capacity(args.repetitions);
    let mut health_samples = Vec::with_capacity(args.repetitions);
    let mut dashboard = Vec::new();
    let mut health = Vec::new();
    let mut search_hits = Vec::new();
    for iteration in sample_iterations(&args) {
        let start = Instant::now();
        for repo in &repositories {
            let status = backend
                .status(&RepoPath::new(repo.path.clone()))
                .await
                .map_err(|e| e.to_string())?;
            store
                .upsert_repo_status(repo.id, &status)
                .await
                .map_err(|e| e.to_string())?;
        }
        let live_ms = ms(start.elapsed());

        let start = Instant::now();
        dashboard = store
            .list_workspace_status(workspace.id)
            .await
            .map_err(|e| e.to_string())?;
        let cached_ms = ms(start.elapsed());

        let start = Instant::now();
        health = workspace_service
            .get_workspace_health(workspace.id)
            .await
            .map_err(|error| error.to_string())?;
        let health_ms = ms(start.elapsed());

        let start = Instant::now();
        search_hits = repo_service
            .global_search(Some(workspace.id), "synthetic commit 1", 30)
            .await
            .map_err(|e| e.to_string())?;
        let search_ms = ms(start.elapsed());
        if is_measured_iteration(&args, iteration) {
            live_samples.push(live_ms);
            cached_samples.push(cached_ms);
            health_samples.push(health_ms);
            search_samples.push(search_ms);
        }
    }

    let need_attention = health
        .iter()
        .filter(|health| health.needs_attention)
        .count();
    let behind_origin = health
        .iter()
        .filter(|health| {
            health.conditions.iter().any(|condition| {
                matches!(
                    condition,
                    fjord_domain::RepoCondition::Behind { .. }
                        | fjord_domain::RepoCondition::Diverged { .. }
                )
            })
        })
        .count();

    println!("workspace_root={}", args.repo.display());
    println!("generated={generated}");
    println!("fixture={}", fixture.hash());
    println!("workspace_repos={}", args.workspace_repos);
    println!("commits_per_repo={}", args.commits);
    println!("files_per_repo={}", args.files);
    println!("dashboard_rows={}", dashboard.len());
    println!("health_rows={}", health.len());
    println!("need_attention={need_attention}");
    println!("behind_origin={behind_origin}");
    let generation_ms = ms(generation_elapsed);
    println!("generation_ms={generation_ms:.3}");
    println!("global_search_hits={}", search_hits.len());

    let mut record = Report::new(
        args.scenario.as_deref().unwrap_or("workspace"),
        fixture.kind,
        &fixture.hash(),
    );
    record
        .fixture_generated(generated)
        .cache_state(args.cache_state)
        .sampling(args.warmups, args.repetitions)
        .count("workspace_repos", args.workspace_repos as u64)
        .count("commits_per_repo", args.commits as u64)
        .count("dashboard_rows", dashboard.len() as u64)
        .count("health_rows", health.len() as u64)
        .count("need_attention", need_attention as u64)
        .count("behind_origin", behind_origin as u64)
        .count("global_search_hits", search_hits.len() as u64)
        // Generation is not a product metric — it is recorded so a run that
        // spent an hour building a fixture is distinguishable from one that
        // reused it.
        .ms("generation", generation_ms);
    let live_distribution = report_distribution(&mut record, "live_refresh", &live_samples);
    let cached_distribution = report_distribution(&mut record, "cached_dashboard", &cached_samples);
    report_distribution(&mut record, "workspace_health", &health_samples);
    report_distribution(&mut record, "global_search", &search_samples);
    for budget in [
        check_distribution_budget(
            "live_refresh",
            &live_distribution,
            args.budget_live_refresh_ms,
        ),
        check_distribution_budget(
            "cached_dashboard",
            &cached_distribution,
            args.budget_cached_dashboard_ms,
        ),
    ]
    .into_iter()
    .flatten()
    {
        record.budget(budget);
    }

    finish(&record, args.json.as_ref(), args.compare.as_deref())
}

#[cfg(test)]
mod sampling_tests {
    use super::*;

    #[test]
    fn budgets_compare_with_p95_not_the_maximum_or_a_single_sample() {
        let mut samples = (1..=19).map(f64::from).collect::<Vec<_>>();
        samples.push(100.0);
        let distribution = Distribution::from_samples(&samples);

        let result = check_distribution_budget("status", &distribution, Some(20.0)).unwrap();

        assert_eq!(distribution.p95, 19.0);
        assert_eq!(distribution.max, 100.0);
        assert_eq!(result.actual_ms, distribution.p95);
        assert!(result.ok, "the one max outlier is not the P95 gate");
    }
}
