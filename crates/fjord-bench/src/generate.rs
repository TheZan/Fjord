//! Fixture construction (docs/tasks.md P6-04–P6-07, specs/performance.md §2).
//!
//! The original generator called `index.add_all(["*"])` and `index.write()` on
//! every commit, so each commit cost a full working-tree scan plus an index
//! write. That is fine for the 200-commit fixtures it was built for and
//! impossible for the Phase 6 ones: 300 000 files rescanned a million times is
//! not a long wait, it is a wait that never ends.
//!
//! [`RepoBuilder`] keeps the index in memory, stages only the paths that
//! changed, and writes the index once at the end. The on-disk index still
//! matches `HEAD` when generation finishes, which is what keeps a generated
//! fixture reporting `dirty_count = 0`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use git2::{Oid, Repository, RepositoryInitOptions, Signature};

/// Files per directory bucket. A flat directory with 300 000 entries is slow to
/// stat on every filesystem Fjord targets and is not what a real repository
/// looks like, so generated trees are nested.
const BUCKET_SIZE: usize = 1_000;

pub struct RepoBuilder {
    repo: Repository,
    index: git2::Index,
    root: PathBuf,
    parent: Option<Oid>,
}

impl RepoBuilder {
    pub fn init(root: &Path) -> Result<Self, String> {
        let mut options = RepositoryInitOptions::new();
        options.initial_head("main");
        let repo = Repository::init_opts(root, &options).map_err(message)?;

        let mut config = repo.config().map_err(message)?;
        config
            .set_str("user.name", "Fjord Bench")
            .map_err(message)?;
        config
            .set_str("user.email", "bench@example.com")
            .map_err(message)?;
        // Generated fixtures must not inherit the host's autocrlf or hook
        // configuration; a fixture that differs per machine is not a fixture.
        config.set_bool("core.autocrlf", false).map_err(message)?;

        let index = repo.index().map_err(message)?;
        Ok(Self {
            repo,
            index,
            root: root.to_path_buf(),
            parent: None,
        })
    }

    /// Writes a file relative to the repository root, creating parents.
    pub fn write_file(&self, relative: &str, contents: &[u8]) -> Result<(), String> {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(path, contents).map_err(|e| e.to_string())
    }

    /// Stages one path. Unlike `add_all`, this does not scan the working tree,
    /// which is the entire point on a large fixture.
    pub fn stage(&mut self, relative: &str) -> Result<(), String> {
        self.index.add_path(Path::new(relative)).map_err(message)
    }

    pub fn commit(&mut self, message_text: &str) -> Result<Oid, String> {
        let tree_oid = self.index.write_tree().map_err(message)?;
        let tree = self.repo.find_tree(tree_oid).map_err(message)?;
        let signature = Signature::now("Fjord Bench", "bench@example.com").map_err(message)?;

        let parents = match self.parent {
            Some(oid) => vec![self.repo.find_commit(oid).map_err(message)?],
            None => Vec::new(),
        };
        let parent_refs = parents.iter().collect::<Vec<_>>();

        let oid = self
            .repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                message_text,
                &tree,
                &parent_refs,
            )
            .map_err(message)?;
        self.parent = Some(oid);
        Ok(oid)
    }

    /// Persists the index so the generated repository reports a clean working
    /// tree. Skipping this leaves every tracked file looking modified.
    pub fn finish(mut self) -> Result<(), String> {
        self.index.write().map_err(message)
    }
}

/// Relative path of generated file `index`, bucketed so no directory holds more
/// than [`BUCKET_SIZE`] entries.
pub fn bench_file_path(prefix: &str, index: usize) -> String {
    format!("{prefix}/{:04}/file-{index:07}.txt", index / BUCKET_SIZE)
}

/// Deterministic filler with enough variation that compression and delta
/// storage behave like they would on real sources.
pub fn bench_file_contents(index: usize, revision: usize) -> Vec<u8> {
    let mut contents = Vec::with_capacity(256);
    let _ = writeln!(contents, "// generated file {index}, revision {revision}");
    for line in 0..8 {
        let _ = writeln!(
            contents,
            "value_{line} = {}",
            index
                .wrapping_mul(2_654_435_761)
                .wrapping_add(line * revision)
        );
    }
    contents
}

/// Progress for generations measured in minutes, so an operator can tell a slow
/// run from a hung one. Written to stderr, keeping stdout parseable.
pub struct Progress {
    label: &'static str,
    total: usize,
    step: usize,
    next: usize,
}

impl Progress {
    pub fn new(label: &'static str, total: usize) -> Self {
        let step = (total / 20).max(1);
        Self {
            label,
            total,
            step,
            next: step,
        }
    }

    pub fn tick(&mut self, done: usize) {
        if done < self.next {
            return;
        }
        self.next = done + self.step;
        let percent = (done as f64 / self.total as f64) * 100.0;
        eprintln!(
            "  {label}: {done}/{total} ({percent:.0}%)",
            label = self.label,
            total = self.total
        );
    }

    pub fn finish(&self) {
        eprintln!("  {}: {} done", self.label, self.total);
    }
}

fn message(error: git2::Error) -> String {
    error.message().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn generated_paths_are_bucketed() {
        assert_eq!(bench_file_path("src", 0), "src/0000/file-0000000.txt");
        assert_eq!(bench_file_path("src", 999), "src/0000/file-0000999.txt");
        assert_eq!(bench_file_path("src", 1_000), "src/0001/file-0001000.txt");
        assert_eq!(bench_file_path("src", 250_000), "src/0250/file-0250000.txt");
    }

    #[test]
    fn contents_change_with_revision() {
        assert_ne!(bench_file_contents(1, 0), bench_file_contents(1, 1));
        assert_ne!(bench_file_contents(1, 0), bench_file_contents(2, 0));
    }

    /// The property every fixture depends on: after generation the working tree
    /// is clean, so `status` measures a clean tree rather than a few thousand
    /// files the generator forgot to stage.
    #[test]
    fn a_built_repository_has_a_clean_working_tree() {
        let dir = TempDir::new().unwrap();
        let mut builder = RepoBuilder::init(dir.path()).unwrap();

        for index in 0..25 {
            let path = bench_file_path("src", index);
            builder
                .write_file(&path, &bench_file_contents(index, 0))
                .unwrap();
            builder.stage(&path).unwrap();
        }
        builder.commit("seed").unwrap();

        let path = bench_file_path("src", 3);
        builder
            .write_file(&path, &bench_file_contents(3, 1))
            .unwrap();
        builder.stage(&path).unwrap();
        builder.commit("second").unwrap();
        builder.finish().unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let statuses = repo.statuses(None).unwrap();
        assert_eq!(
            statuses.len(),
            0,
            "a generated fixture must report no pending changes"
        );
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("second"));
    }

    #[test]
    fn commits_form_a_chain() {
        let dir = TempDir::new().unwrap();
        let mut builder = RepoBuilder::init(dir.path()).unwrap();

        builder.write_file("a.txt", b"one").unwrap();
        builder.stage("a.txt").unwrap();
        let first = builder.commit("first").unwrap();
        builder.write_file("a.txt", b"two").unwrap();
        builder.stage("a.txt").unwrap();
        let second = builder.commit("second").unwrap();
        builder.finish().unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.find_commit(second).unwrap();
        assert_eq!(head.parent_id(0).unwrap(), first);
    }
}
