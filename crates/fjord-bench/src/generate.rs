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
use std::io::{BufWriter, Write};
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

    pub fn head(&self) -> Option<Oid> {
        self.parent
    }

    /// Creates a direct reference. Used for the thousands of branches and tags
    /// `refs-many` needs, which are cheap: a ref is a file holding an id.
    pub fn reference(&self, name: &str, target: Oid) -> Result<(), String> {
        self.repo
            .reference(name, target, true, "fjord-bench")
            .map(|_| ())
            .map_err(message)
    }

    /// Registers a remote and its fetch refspec without contacting anything.
    /// The URL is unreachable on purpose: these fixtures must never touch the
    /// network, and a fixture that could would eventually be run somewhere it
    /// resolves.
    pub fn add_remote(&self, name: &str) -> Result<(), String> {
        self.repo
            .remote(name, &format!("https://fjord.invalid/{name}.git"))
            .map(|_| ())
            .map_err(message)
    }

    /// Persists the index so the generated repository reports a clean working
    /// tree. Skipping this leaves every tracked file looking modified.
    pub fn finish(mut self) -> Result<(), String> {
        self.index.write().map_err(message)
    }
}

/// Writes Git's commit-graph file.
///
/// A million-commit repository in the wild always has one — `git gc` and
/// `git maintenance` write it — so measuring history traversal without it would
/// produce a pessimistic number for a situation users are not in, and would
/// send us optimizing a cost that does not exist. It is part of the fixture's
/// identity, not an optional extra, so a missing `git` fails the generation
/// rather than silently producing a different fixture.
pub fn write_commit_graph(root: &Path) -> Result<(), String> {
    git(root, &["commit-graph", "write", "--reachable"])
}

/// Appends a linear history directly to a pack through `git fast-import`.
///
/// History fixtures measure revision traversal, not one million working-tree
/// mutations. Reusing the seed tree preserves the exact graph depth while
/// avoiding millions of redundant blob/tree objects, index writes, ref locks,
/// and loose files. `fast-import` writes a pack as it streams, turning the 1M
/// variant from a multi-day NTFS workload into a practical fixture.
pub fn append_history(root: &Path, seed: Oid, additional_commits: usize) -> Result<(), String> {
    if additional_commits == 0 {
        return Ok(());
    }

    let mut child = std::process::Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start `git fast-import`: {error}"))?;
    let stdin = child.stdin.take().ok_or("git fast-import has no stdin")?;
    let mut input = BufWriter::with_capacity(1024 * 1024, stdin);

    for index in 1..=additional_commits {
        let message = format!("synthetic commit {index}");
        let parent = if index == 1 {
            seed.to_string()
        } else {
            format!(":{}", index - 1)
        };
        let timestamp = 1_700_000_000_i64 + index as i64;
        writeln!(input, "commit refs/heads/main").map_err(|e| e.to_string())?;
        writeln!(input, "mark :{index}").map_err(|e| e.to_string())?;
        writeln!(
            input,
            "author Fjord Bench <bench@example.com> {timestamp} +0000"
        )
        .map_err(|e| e.to_string())?;
        writeln!(
            input,
            "committer Fjord Bench <bench@example.com> {timestamp} +0000"
        )
        .map_err(|e| e.to_string())?;
        writeln!(input, "data {}", message.len()).map_err(|e| e.to_string())?;
        writeln!(input, "{message}").map_err(|e| e.to_string())?;
        writeln!(input, "from {parent}\n").map_err(|e| e.to_string())?;
    }
    writeln!(input, "done").map_err(|e| e.to_string())?;
    input.flush().map_err(|e| e.to_string())?;
    drop(input);

    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not wait for `git fast-import`: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "`git fast-import` failed with {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Packs loose objects into a packfile, if any are loose.
///
/// The generator creates objects one commit at a time and never packs, so a
/// 500 000-commit fixture ends up with roughly 2.5 million loose object files
/// and no packfile. No real repository looks like that: Git packs during `gc`,
/// and a clone arrives packed. On NTFS the difference is not a constant factor
/// — every object read becomes its own file open, and a history walk that Git
/// finishes in milliseconds runs for minutes.
///
/// Called on every materialize rather than only on generation, so fixtures
/// built before this existed are repaired in place instead of being thrown
/// away and rebuilt over hours. Idempotent: an already-packed store is left
/// alone.
pub fn ensure_packed(root: &Path) -> Result<bool, String> {
    if !has_loose_objects(root) {
        return Ok(false);
    }

    eprintln!("  packing loose objects in {} …", root.display());
    git(root, &["repack", "-a", "-d", "--quiet"])?;
    // `repack -d` removes packs it replaced; loose objects now duplicated in a
    // pack are dropped separately.
    git(root, &["prune-packed", "--quiet"])?;
    Ok(true)
}

/// Cheap probe: inspect at most one entry in each fanout directory. Sampling a
/// few hard-coded prefixes missed small repositories whenever their hashes
/// landed elsewhere, leaving the fixture unpacked. Walking the 256 directory
/// names is still constant work even when they contain millions of objects.
fn has_loose_objects(root: &Path) -> bool {
    let objects = root.join(".git").join("objects");
    std::fs::read_dir(objects)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.file_name().to_str().is_some_and(|name| {
                    name.len() == 2 && name.bytes().all(|b| b.is_ascii_hexdigit())
                })
        })
        .any(|entry| {
            std::fs::read_dir(entry.path())
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
        })
}

/// Packs refs into `.git/packed-refs`.
///
/// A repository carrying thousands of refs has them packed: Git packs on `gc`,
/// and a clone receives them packed to begin with. Ten thousand loose ref files
/// is a state that occurs briefly after a large fetch, not the state a user's
/// repository sits in, so measuring against it would measure the wrong steady
/// state. Packed-ness is part of the fixture's identity.
pub fn pack_refs(root: &Path) -> Result<(), String> {
    git(root, &["pack-refs", "--all"])
}

/// Runs a Git subcommand inside a generated fixture.
///
/// Fixtures that need Git say so by failing when it is missing, rather than
/// quietly producing a differently-shaped fixture — which would be
/// indistinguishable in the manifest and different in every measurement.
fn git(root: &Path, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|error| {
            format!(
                "could not run `git {}` in {}: {error}. This fixture requires Git on PATH.",
                args.join(" "),
                root.display()
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "`git {}` failed with {:?}: {}",
        args.join(" "),
        output.status.code(),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
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
