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

use crate::generate::{bench_file_contents, bench_file_path, Progress, RepoBuilder};
use crate::manifest::{self, Fixture, Preparation};

/// Overrides a caller may apply to a named fixture's defaults, so the two size
/// variants of a fixture do not need two names.
#[derive(Debug, Default, Clone, Copy)]
pub struct Overrides {
    pub files: Option<usize>,
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
}

/// Which measurement a fixture exists to support.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// `status` against the generated working tree (SLO-6, SLO-7).
    Status,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub name: &'static str,
    pub scenario: Scenario,
    pub fixture: Fixture,
    pub build: Build,
}

pub const NAMES: &[&str] = &["wt-huge", "wt-noisy"];

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
                    .with("untracked", 20_000),
                build: Build::WorkingTree {
                    tracked,
                    ignored: 200_000,
                    untracked: 20_000,
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
        return Ok(false);
    }

    eprintln!("generating fixture {} at {}", plan.name, path.display());
    match plan.build {
        Build::WorkingTree {
            tracked,
            ignored,
            untracked,
        } => build_working_tree(path, tracked, ignored, untracked)?,
    }

    manifest::write(path, &plan.fixture)?;
    Ok(true)
}

/// A wide working tree: `tracked` committed files, `ignored` files excluded by
/// a committed `.gitignore`, and `untracked` files that are neither.
fn build_working_tree(
    path: &Path,
    tracked: usize,
    ignored: usize,
    untracked: usize,
) -> Result<(), String> {
    let mut builder = RepoBuilder::init(path)?;
    manifest::exclude_from_git(path)?;

    // Committed first, so the ignore rules apply to everything written after.
    builder.write_file(".gitignore", b"generated/\nlocal/\n")?;
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

    // Ignored and untracked files are written after the commits: they must not
    // enter history, and the ignored ones must be invisible to `status`.
    let mut progress = Progress::new("ignored files", ignored);
    for index in 0..ignored {
        let file = bench_file_path("generated", index);
        write_plain(path, &file, index)?;
        progress.tick(index + 1);
    }
    if ignored > 0 {
        progress.finish();
    }

    let mut progress = Progress::new("untracked files", untracked);
    for index in 0..untracked {
        let file = bench_file_path("scratch", index);
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
