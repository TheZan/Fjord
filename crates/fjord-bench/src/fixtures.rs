//! The fixture catalogue (specs/performance.md §2).
//!
//! Named fixtures rather than loose flags, because the names are the join key
//! between an SLO, a scenario, and a recorded result. `--fixture wt-huge` is
//! reproducible and quotable; `--files 300000 --commits 1` is a set of numbers
//! someone has to get right every time.
//!
//! Fixtures are expensive to build — hours, for the largest — so every plan
//! carries a [`Fixture`] manifest and generation is skipped when the parameters
//! already match (P6-02).

use std::path::Path;

use crate::generate::{self, bench_file_contents, bench_file_path, Progress, RepoBuilder};
use crate::manifest::{self, Fixture, Preparation};

/// Overrides a caller may apply to a named fixture's defaults, so the two size
/// variants of a fixture do not need two names.
#[derive(Debug, Default, Clone, Copy)]
pub struct Overrides {
    pub files: Option<usize>,
    pub commits: Option<usize>,
    pub workspace_repos: Option<usize>,
}

/// What to build, once the name and overrides are resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Build {
    /// A wide working tree with a shallow history: the shape that makes
    /// `status` expensive.
    WorkingTree {
        tracked: usize,
        ignored: usize,
        untracked: usize,
    },
    /// A deep history over a narrow tree: the shape that makes commit traversal
    /// expensive.
    History { commits: usize, files: usize },
    /// A modest history carrying thousands of refs.
    Refs {
        commits: usize,
        branches: usize,
        tags: usize,
        remotes: usize,
    },
    /// A few very large files, each modified once so a diff exists.
    Diff {
        large_text_mb: usize,
        long_text_lines: usize,
        binary_mb: usize,
    },
    /// Many repositories under one root — the workspace shape.
    Workspace {
        repos: usize,
        commits: usize,
        files: usize,
    },
}

/// Which measurement a fixture exists to support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// `status` against the generated working tree (SLO-6, SLO-7).
    Status,
    /// The first page of history, the read a repository view waits on (SLO-8).
    LogFirstPage,
    /// Branches and tags together, as the repository tree loads them (SLO-16).
    RefsRead,
    /// A single file's full diff — the payload P6-16 will window (SLO-9/10).
    FileDiff,
    /// Live status refresh plus the cached dashboard read (SLO-3, SLO-15).
    WorkspaceDashboard,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub name: &'static str,
    pub scenario: Scenario,
    pub fixture: Fixture,
    pub build: Build,
}

pub const NAMES: &[&str] = &[
    "wt-huge",
    "wt-noisy",
    "hist-deep",
    "refs-many",
    "diff-giant",
    "ws-100",
];

/// The file `diff-giant` measures against — the large text file, which is the
/// case a diff view has to survive rather than the one it cannot render at all.
pub const DIFF_TARGET: &str = "huge/large.txt";

/// Resolves a fixture name and any overrides into a concrete plan.
pub fn plan(name: &str, overrides: Overrides) -> Result<Plan, String> {
    match name {
        // SLO-6. The default is the smaller variant; `--files 300000` selects
        // the larger one, because a 300k-file generation is a deliberate act.
        "wt-huge" => {
            let tracked = overrides.files.unwrap_or(150_000);
            Ok(Plan {
                name: "wt-huge",
                scenario: Scenario::Status,
                fixture: Fixture::new("working-tree")
                    .with("tracked", tracked)
                    .with("ignored", 0)
                    .with("untracked", 0),
                build: Build::WorkingTree {
                    tracked,
                    ignored: 0,
                    untracked: 0,
                },
            })
        }
        // SLO-7 and SLO-11. Ignored and untracked files are the cost `status`
        // pays that a tracked-file count alone never predicts: the walker has
        // to see them to decide they do not matter.
        "wt-noisy" => {
            let tracked = overrides.files.unwrap_or(50_000);
            Ok(Plan {
                name: "wt-noisy",
                scenario: Scenario::Status,
                fixture: Fixture::new("working-tree")
                    .with("tracked", tracked)
                    .with("ignored", 200_000)
                    .with("untracked", 20_000)
                    // Where the noise sits is the measurement. The first
                    // layout parked it in its own subtrees, which Git skips
                    // wholesale; `interleaved` spreads it through the tracked
                    // buckets. `wt-huge` carries no noise and so has no
                    // layout to describe — its identity is unaffected.
                    .with("layout", "interleaved"),
                build: Build::WorkingTree {
                    tracked,
                    ignored: 200_000,
                    untracked: 20_000,
                },
            })
        }
        // SLO-8. The default is the smaller variant; `--commits 1000000`
        // selects the larger one. Few files, so the cost is history traversal
        // rather than tree width — the opposite shape to `wt-huge`.
        "hist-deep" => {
            let commits = overrides.commits.unwrap_or(500_000);
            let files = overrides.files.unwrap_or(50);
            Ok(Plan {
                name: "hist-deep",
                scenario: Scenario::LogFirstPage,
                fixture: Fixture::new("history")
                    .with("commits", commits)
                    .with("files", files)
                    // Part of the identity: a fixture with a commit-graph and
                    // one without are different measurements.
                    .with("commit_graph", true),
                build: Build::History { commits, files },
            })
        }
        // SLO-16. Refs are cheap to create and expensive to enumerate, which is
        // exactly why a repository with thousands of them is worth measuring.
        "refs-many" => {
            let commits = overrides.commits.unwrap_or(2_000);
            Ok(Plan {
                name: "refs-many",
                scenario: Scenario::RefsRead,
                fixture: Fixture::new("refs")
                    .with("commits", commits)
                    .with("branches", 5_000)
                    .with("tags", 5_000)
                    .with("remotes", 20)
                    // Loose and packed refs are different measurements, so
                    // which one this is belongs in the identity.
                    .with("packed", true),
                build: Build::Refs {
                    commits,
                    branches: 5_000,
                    tags: 5_000,
                    remotes: 20,
                },
            })
        }
        // SLO-9 and SLO-10. Three shapes that break a diff view differently:
        // one file too large to hold comfortably, one with too many lines to
        // render, and one with no line representation at all.
        "diff-giant" => Ok(Plan {
            name: "diff-giant",
            scenario: Scenario::FileDiff,
            fixture: Fixture::new("diff")
                .with("large_text_mb", 50)
                .with("long_text_lines", 500_000)
                .with("binary_mb", 20),
            build: Build::Diff {
                large_text_mb: 50,
                long_text_lines: 500_000,
                binary_mb: 20,
            },
        }),
        // SLO-3, SLO-13, SLO-14, SLO-15. The workspace shape: the cost is the
        // number of repositories, not the size of any one of them.
        "ws-100" => {
            let repos = overrides.workspace_repos.unwrap_or(100);
            let commits = overrides.commits.unwrap_or(2_000);
            let files = overrides.files.unwrap_or(50);
            Ok(Plan {
                name: "ws-100",
                scenario: Scenario::WorkspaceDashboard,
                fixture: Fixture::new("workspace")
                    .with("repos", repos)
                    .with("commits_per_repo", commits)
                    .with("files_per_repo", files),
                build: Build::Workspace {
                    repos,
                    commits,
                    files,
                },
            })
        }
        other => Err(format!(
            "unknown fixture '{other}'; available: {}",
            NAMES.join(", ")
        )),
    }
}

/// Builds `plan` at `path` unless an identical fixture is already there.
/// Returns whether generation ran.
pub fn materialize(path: &Path, plan: &Plan, force: bool) -> Result<bool, String> {
    if manifest::prepare(path, &plan.fixture, force)? == Preparation::Reuse {
        eprintln!("fixture {} reused at {}", plan.name, path.display());
        // Repairs fixtures built before packing was part of generation, so
        // hours of generation are not thrown away over a property that can be
        // fixed in place. Runs before any measurement, so a repaired fixture
        // is still timed in its final state.
        ensure_packed_fixture(path, &plan.build)?;
        return Ok(false);
    }

    eprintln!("generating fixture {} at {}", plan.name, path.display());
    match plan.build {
        Build::WorkingTree {
            tracked,
            ignored,
            untracked,
        } => build_working_tree(path, tracked, ignored, untracked)?,
        Build::History { commits, files } => build_history(path, commits, files)?,
        Build::Refs {
            commits,
            branches,
            tags,
            remotes,
        } => build_refs(path, commits, branches, tags, remotes)?,
        Build::Diff {
            large_text_mb,
            long_text_lines,
            binary_mb,
        } => build_diff(path, large_text_mb, long_text_lines, binary_mb)?,
        Build::Workspace {
            repos,
            commits,
            files,
        } => build_workspace(path, repos, commits, files)?,
    }

    ensure_packed_fixture(path, &plan.build)?;
    manifest::write(path, &plan.fixture)?;
    Ok(true)
}

/// Packs every repository a fixture contains. A workspace holds one per
/// directory; everything else is a single repository at the root.
fn ensure_packed_fixture(path: &Path, build: &Build) -> Result<(), String> {
    if !matches!(build, Build::Workspace { .. }) {
        generate::ensure_packed(path)?;
        return Ok(());
    }

    let mut entries: Vec<_> = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|candidate| candidate.join(".git").exists())
        .collect();
    entries.sort();

    let mut progress = Progress::new("packing repositories", entries.len());
    for (index, repo) in entries.iter().enumerate() {
        generate::ensure_packed(repo)?;
        progress.tick(index + 1);
    }
    progress.finish();
    Ok(())
}

/// A narrow tree with a deep history, plus the commit-graph a repository this
/// size always has in practice.
fn build_history(path: &Path, commits: usize, files: usize) -> Result<(), String> {
    let builder = seed_repository(path, files)?;
    let seed = builder.head().expect("the seed commit exists");
    builder.finish()?;

    eprintln!(
        "  streaming {} commits into a pack",
        commits.saturating_sub(1)
    );
    generate::append_history(path, seed, commits.saturating_sub(1))?;

    eprintln!("  writing commit-graph");
    generate::write_commit_graph(path)
}

/// A modest history carrying thousands of branches, tags, and remote-tracking
/// refs. Refs are spread across the history rather than stacked on `HEAD`, so
/// enumerating them touches many distinct commits the way a real repository
/// does.
fn build_refs(
    path: &Path,
    commits: usize,
    branches: usize,
    tags: usize,
    remotes: usize,
) -> Result<(), String> {
    let mut builder = seed_repository(path, 20)?;

    let mut history = Vec::with_capacity(commits);
    history.push(builder.head().expect("the seed commit exists"));
    let mut progress = Progress::new("commits", commits);
    for index in 1..commits {
        let file = bench_file_path("src", index % 20);
        builder.write_file(&file, &bench_file_contents(index % 20, index))?;
        builder.stage(&file)?;
        history.push(builder.commit(&format!("synthetic commit {index}"))?);
        progress.tick(index + 1);
    }
    progress.finish();

    let target = |index: usize| history[index % history.len()];

    let mut progress = Progress::new("branches", branches);
    for index in 0..branches {
        builder.reference(
            &format!("refs/heads/feature/branch-{index:05}"),
            target(index),
        )?;
        progress.tick(index + 1);
    }
    progress.finish();

    let mut progress = Progress::new("tags", tags);
    for index in 0..tags {
        builder.reference(&format!("refs/tags/v0.{index}"), target(index * 7))?;
        progress.tick(index + 1);
    }
    progress.finish();

    for remote in 0..remotes {
        let name = format!("remote-{remote:02}");
        builder.add_remote(&name)?;
        // A handful of tracking refs each, so remote branches are enumerated
        // alongside local ones rather than being a config-only entry.
        for index in 0..(branches / remotes.max(1)).min(250) {
            builder.reference(
                &format!("refs/remotes/{name}/topic-{index:04}"),
                target(index * 3 + remote),
            )?;
        }
    }
    eprintln!("  remotes: {remotes} done");
    builder.finish()?;

    eprintln!("  packing refs");
    generate::pack_refs(path)
}

/// Three files that break a diff view in different ways, each committed and
/// then modified, so `HEAD` carries a real diff against its parent.
fn build_diff(
    path: &Path,
    large_text_mb: usize,
    long_text_lines: usize,
    binary_mb: usize,
) -> Result<(), String> {
    let mut builder = RepoBuilder::init(path)?;
    manifest::exclude_from_git(path)?;

    // Git treats a file with a NUL byte as binary, which is the point: the
    // diff view must recognize it without attempting to render lines.
    let binary = (0..binary_mb * 1024 * 1024)
        .map(|index| (index % 256) as u8)
        .collect::<Vec<_>>();

    eprintln!("  writing large text file ({large_text_mb} MB)");
    builder.write_file(DIFF_TARGET, &filler_text(large_text_mb * 1024 * 1024, 0))?;
    builder.stage(DIFF_TARGET)?;

    eprintln!("  writing long text file ({long_text_lines} lines)");
    builder.write_file("huge/long.txt", &numbered_lines(long_text_lines, 0))?;
    builder.stage("huge/long.txt")?;

    eprintln!("  writing binary blob ({binary_mb} MB)");
    builder.write_file("huge/blob.bin", &binary)?;
    builder.stage("huge/blob.bin")?;
    builder.commit("seed giant files")?;

    // Modify each one, so every file has something to diff.
    builder.write_file(DIFF_TARGET, &filler_text(large_text_mb * 1024 * 1024, 1))?;
    builder.stage(DIFF_TARGET)?;
    builder.write_file("huge/long.txt", &numbered_lines(long_text_lines, 1))?;
    builder.stage("huge/long.txt")?;
    builder.write_file(
        "huge/blob.bin",
        &binary.iter().rev().copied().collect::<Vec<_>>(),
    )?;
    builder.stage("huge/blob.bin")?;
    builder.commit("revise giant files")?;

    builder.finish()
}

/// Text of roughly `bytes`, with every line differing between revisions so the
/// diff is dense rather than a single changed line at the top.
fn filler_text(bytes: usize, revision: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes + 64);
    let mut line = 0usize;
    while out.len() < bytes {
        out.extend_from_slice(
            format!(
                "line {line:08} revision {revision} {:x}\n",
                line * 2_654_435_761usize
            )
            .as_bytes(),
        );
        line += 1;
    }
    out
}

fn numbered_lines(lines: usize, revision: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(lines * 32);
    for line in 0..lines {
        out.extend_from_slice(format!("{line:07}: value {}\n", line + revision).as_bytes());
    }
    out
}

/// Many repositories under one root. Each is a small repository built with the
/// fast builder; the cost this fixture measures is their number.
fn build_workspace(path: &Path, repos: usize, commits: usize, files: usize) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())?;

    let mut progress = Progress::new("repositories", repos);
    for index in 0..repos {
        let repo_path = path.join(format!("repo-{index:03}"));
        let mut builder = seed_repository(&repo_path, files)?;
        for commit in 1..commits {
            let file = bench_file_path("src", commit % files);
            builder.write_file(&file, &bench_file_contents(commit % files, commit))?;
            builder.stage(&file)?;
            builder.commit(&format!("synthetic commit {commit}"))?;
        }
        builder.finish()?;
        progress.tick(index + 1);
    }
    progress.finish();
    Ok(())
}

/// Initializes a repository with `files` tracked files and one commit — the
/// starting point every non-working-tree fixture builds on.
fn seed_repository(path: &Path, files: usize) -> Result<RepoBuilder, String> {
    let mut builder = RepoBuilder::init(path)?;
    manifest::exclude_from_git(path)?;

    for index in 0..files {
        let file = bench_file_path("src", index);
        builder.write_file(&file, &bench_file_contents(index, 0))?;
        builder.stage(&file)?;
    }
    builder.commit("seed synthetic repository")?;
    Ok(builder)
}

/// A wide working tree: `tracked` committed files, `ignored` files excluded by
/// a committed `.gitignore`, and `untracked` files that are neither.
///
/// The noisy files are **interleaved with the tracked ones**, not parked in
/// their own subtrees. The first version of this fixture put them under
/// `generated/` and `scratch/`, and measured almost nothing: Git collapses a
/// wholly-untracked directory into a single `?? scratch/` entry and stops
/// descending, and it skips an ignored directory outright. Twenty thousand
/// untracked files cost about as much as one, and `wt-noisy` came out twice as
/// fast as `wt-huge` despite holding more files. A real repository's noise
/// sits beside its sources — build output next to the code that produced it —
/// so that is where this fixture puts it, and the walker has to look at every
/// one of them.
fn build_working_tree(
    path: &Path,
    tracked: usize,
    ignored: usize,
    untracked: usize,
) -> Result<(), String> {
    let mut builder = RepoBuilder::init(path)?;
    manifest::exclude_from_git(path)?;

    // Extension rules rather than directory rules: a directory rule lets Git
    // skip a whole subtree, which is exactly the shortcut this fixture must
    // not offer.
    builder.write_file(".gitignore", b"*.generated\n*.log\n")?;
    builder.stage(".gitignore")?;

    let mut progress = Progress::new("tracked files", tracked);
    for index in 0..tracked {
        let file = bench_file_path("src", index);
        builder.write_file(&file, &bench_file_contents(index, 0))?;
        builder.stage(&file)?;
        progress.tick(index + 1);
    }
    progress.finish();

    builder.commit("seed working tree")?;
    // One more commit so history is not a single root commit: `log` and
    // ahead/behind paths behave differently against a one-commit repository.
    let touched = bench_file_path("src", 0);
    if tracked > 0 {
        builder.write_file(&touched, &bench_file_contents(0, 1))?;
        builder.stage(&touched)?;
        builder.commit("second revision")?;
    }
    builder.finish()?;

    // Written after the commits so they never enter history, and spread across
    // the same buckets the tracked files live in so no directory is uniformly
    // ignored or uniformly untracked.
    let buckets = tracked.div_ceil(1_000).max(1);

    let mut progress = Progress::new("ignored files", ignored);
    for index in 0..ignored {
        let file = format!("src/{:04}/build-{index:07}.generated", index % buckets);
        write_plain(path, &file, index)?;
        progress.tick(index + 1);
    }
    if ignored > 0 {
        progress.finish();
    }

    let mut progress = Progress::new("untracked files", untracked);
    for index in 0..untracked {
        let file = format!("src/{:04}/scratch-{index:07}.txt", index % buckets);
        write_plain(path, &file, index)?;
        progress.tick(index + 1);
    }
    if untracked > 0 {
        progress.finish();
    }

    Ok(())
}

fn write_plain(root: &Path, relative: &str, index: usize) -> Result<(), String> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bench_file_contents(index, 0)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use tempfile::TempDir;

    #[test]
    fn named_fixtures_carry_their_parameters() {
        let huge = plan("wt-huge", Overrides::default()).unwrap();
        assert_eq!(
            huge.build,
            Build::WorkingTree {
                tracked: 150_000,
                ignored: 0,
                untracked: 0
            }
        );

        let noisy = plan("wt-noisy", Overrides::default()).unwrap();
        assert!(matches!(
            noisy.build,
            Build::WorkingTree {
                ignored: 200_000,
                untracked: 20_000,
                ..
            }
        ));
    }

    /// The 300k variant must be a different fixture, not the same one relabeled,
    /// or reuse would hand a 150k tree to a 300k run.
    #[test]
    fn an_override_changes_the_fixture_identity() {
        let default = plan("wt-huge", Overrides::default()).unwrap();
        let larger = plan(
            "wt-huge",
            Overrides {
                files: Some(300_000),
                ..Overrides::default()
            },
        )
        .unwrap();

        assert_ne!(default.fixture.hash(), larger.fixture.hash());
    }

    #[test]
    fn an_unknown_name_lists_what_exists() {
        let error = plan("wt-enormous", Overrides::default()).unwrap_err();
        assert!(error.contains("wt-huge"), "unexpected error: {error}");
    }

    /// Built small, because the point is the shape: tracked files committed,
    /// ignored files invisible, untracked files visible but uncommitted.
    #[test]
    fn a_working_tree_fixture_has_the_shape_it_claims() {
        let dir = TempDir::new().unwrap();
        build_working_tree(dir.path(), 12, 5, 3).unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.head().unwrap().peel_to_tree().unwrap();
        // 12 generated files plus .gitignore, in nested buckets.
        let mut committed = 0;
        head.walk(git2::TreeWalkMode::PreOrder, |_, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                committed += 1;
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        assert_eq!(committed, 13);

        let statuses = repo.statuses(None).unwrap();
        let untracked = statuses
            .iter()
            .filter(|entry| entry.status().contains(git2::Status::WT_NEW))
            .count();
        assert_eq!(
            untracked, 3,
            "ignored files must not appear; untracked ones must"
        );
    }

    /// The invariant that makes `wt-noisy` measure anything at all: no
    /// directory is uniformly ignored or uniformly untracked, so Git cannot
    /// skip a subtree or collapse it into one `?? dir/` entry.
    ///
    /// Asserted on the layout rather than through a status call, because the
    /// engine that reads it is the thing under test — the original fixture
    /// looked correct to `git2` in this very test while `gix` reported one
    /// entry for twenty thousand untracked files.
    #[test]
    fn noisy_files_share_directories_with_tracked_ones() {
        let dir = TempDir::new().unwrap();
        build_working_tree(dir.path(), 12, 5, 3).unwrap();

        let mut checked = 0;
        for bucket in std::fs::read_dir(dir.path().join("src")).unwrap() {
            let bucket = bucket.unwrap().path();
            let names: Vec<String> = std::fs::read_dir(&bucket)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();

            let tracked = names
                .iter()
                .filter(|name| name.starts_with("file-"))
                .count();
            let noisy = names
                .iter()
                .filter(|name| name.starts_with("build-") || name.starts_with("scratch-"))
                .count();

            if noisy > 0 {
                assert!(
                    tracked > 0,
                    "{} holds only noise; Git would skip or collapse it",
                    bucket.display()
                );
                checked += 1;
            }
        }
        assert!(checked > 0, "the fixture must actually contain noise");

        // And nothing may sit in a subtree of its own.
        assert!(!dir.path().join("scratch").exists());
        assert!(!dir.path().join("generated").exists());
    }

    #[test]
    fn history_and_refs_fixtures_carry_their_parameters() {
        let deep = plan("hist-deep", Overrides::default()).unwrap();
        assert_eq!(
            deep.build,
            Build::History {
                commits: 500_000,
                files: 50
            }
        );
        assert_eq!(deep.scenario, Scenario::LogFirstPage);

        let million = plan(
            "hist-deep",
            Overrides {
                commits: Some(1_000_000),
                ..Overrides::default()
            },
        )
        .unwrap();
        assert_ne!(
            deep.fixture.hash(),
            million.fixture.hash(),
            "the 1M variant must not be served from the 500k directory"
        );

        let refs = plan("refs-many", Overrides::default()).unwrap();
        assert!(matches!(
            refs.build,
            Build::Refs {
                branches: 5_000,
                tags: 5_000,
                remotes: 20,
                ..
            }
        ));
        assert_eq!(refs.scenario, Scenario::RefsRead);
    }

    /// Built small: the shape is what matters, and the shape is that the
    /// history is a chain of the requested length over a clean tree.
    #[test]
    fn a_history_fixture_has_the_requested_depth() {
        let dir = TempDir::new().unwrap();
        build_history(dir.path(), 25, 4).unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let mut walk = repo.revwalk().unwrap();
        walk.push_head().unwrap();
        assert_eq!(walk.count(), 25);
        assert_eq!(repo.statuses(None).unwrap().len(), 0);
        assert!(
            dir.path().join(".git/objects/info/commit-graph").exists(),
            "a deep-history fixture must carry the commit-graph a real one would"
        );
    }

    /// Refs must land on distinct commits rather than all on HEAD, or
    /// enumerating them would touch one object and measure nothing.
    #[test]
    fn a_refs_fixture_spreads_refs_across_history() {
        let dir = TempDir::new().unwrap();
        build_refs(dir.path(), 40, 30, 20, 3).unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let branches = repo
            .references_glob("refs/heads/feature/*")
            .unwrap()
            .count();
        let tags = repo.references_glob("refs/tags/*").unwrap().count();
        let remote_refs = repo.references_glob("refs/remotes/*/*").unwrap().count();
        assert_eq!(branches, 30);
        assert_eq!(tags, 20);
        assert!(remote_refs > 0, "remotes must have tracking refs");
        assert_eq!(repo.remotes().unwrap().len(), 3);
        assert!(
            dir.path().join(".git/packed-refs").exists(),
            "a repository with thousands of refs has them packed; measuring \
             loose refs would measure a state users are not in"
        );

        let distinct = repo
            .references_glob("refs/heads/feature/*")
            .unwrap()
            .filter_map(|reference| reference.ok()?.target())
            .collect::<std::collections::HashSet<_>>();
        assert!(
            distinct.len() > 1,
            "refs stacked on one commit would measure nothing"
        );
    }

    /// Built at a fraction of the real size: the shape is that each giant file
    /// has a diff against its parent, and that the binary one is recognized
    /// without being rendered.
    #[test]
    fn a_diff_fixture_gives_every_giant_file_something_to_diff() {
        let dir = TempDir::new().unwrap();
        build_diff(dir.path(), 1, 500, 1).unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let parent = head.parent(0).unwrap();
        let diff = repo
            .diff_tree_to_tree(
                Some(&parent.tree().unwrap()),
                Some(&head.tree().unwrap()),
                None,
            )
            .unwrap();

        assert_eq!(diff.deltas().len(), 3, "every giant file must have changed");
        assert_eq!(repo.statuses(None).unwrap().len(), 0);

        let blob = head
            .tree()
            .unwrap()
            .get_path(std::path::Path::new("huge/blob.bin"))
            .unwrap()
            .to_object(&repo)
            .unwrap();
        assert!(
            blob.as_blob().unwrap().is_binary(),
            "the blob must be detected as binary, not diffed as text"
        );
    }

    #[test]
    fn a_workspace_fixture_builds_independent_repositories() {
        let dir = TempDir::new().unwrap();
        build_workspace(dir.path(), 3, 5, 4).unwrap();

        for index in 0..3 {
            let repo = Repository::open(dir.path().join(format!("repo-{index:03}"))).unwrap();
            let mut walk = repo.revwalk().unwrap();
            walk.push_head().unwrap();
            assert_eq!(walk.count(), 5);
            assert_eq!(repo.statuses(None).unwrap().len(), 0);
        }
    }

    /// Loose objects are a generation artifact, not a property of any real
    /// repository, and on a large fixture they turn a millisecond read into a
    /// minutes-long one. Every materialized fixture must be packed.
    #[test]
    fn a_materialized_fixture_has_its_objects_packed() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fixture");
        let plan = plan(
            "hist-deep",
            Overrides {
                commits: Some(20),
                files: Some(3),
                workspace_repos: None,
            },
        )
        .unwrap();

        assert!(materialize(&path, &plan, false).unwrap());

        let packs = std::fs::read_dir(path.join(".git/objects/pack"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "pack"))
            .count();
        assert!(packs > 0, "a generated fixture must carry a packfile");

        // And reusing it must not undo that.
        assert!(!materialize(&path, &plan, false).unwrap());
        assert!(
            !generate::ensure_packed(&path).unwrap(),
            "packing is idempotent"
        );
    }

    #[test]
    fn materialize_reuses_a_matching_fixture() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fixture");
        let plan = Plan {
            name: "wt-huge",
            scenario: Scenario::Status,
            fixture: Fixture::new("working-tree")
                .with("tracked", 4)
                .with("ignored", 0)
                .with("untracked", 0),
            build: Build::WorkingTree {
                tracked: 4,
                ignored: 0,
                untracked: 0,
            },
        };

        assert!(
            materialize(&path, &plan, false).unwrap(),
            "first run builds"
        );
        assert!(
            !materialize(&path, &plan, false).unwrap(),
            "second run reuses"
        );
    }
}
