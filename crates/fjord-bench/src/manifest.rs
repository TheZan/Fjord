//! Fixture manifests and reuse (docs/tasks.md P6-02, specs/performance.md §2).
//!
//! Generation is expensive — the recorded 24×2500-commit workspace took ~212 s,
//! and the Phase 6 fixtures are an order of magnitude larger — so fixtures must
//! be reusable across runs. Reuse was previously decided by "does a `.git`
//! directory exist", which meant that running the same path with different
//! `--commits` silently benchmarked the *old* fixture and reported the new
//! parameters. A wrong number presented confidently is worse than no number.
//!
//! A manifest records what a fixture actually is. A run reuses the directory
//! only when every parameter matches; otherwise it regenerates. Directories
//! Fjord did not create are never deleted, whatever the flags say.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Bumped when the generator's output changes in a way that invalidates
/// existing fixtures, so stale directories regenerate instead of producing
/// numbers that cannot be compared with new ones.
pub const SCHEMA_VERSION: u32 = 1;

pub const MANIFEST_FILE: &str = ".fjord-bench-manifest.json";
/// Kept from the original harness: the guard that says a directory is ours to
/// delete. A manifest implies it, but older fixtures have only the marker.
pub const MARKER_FILE: &str = ".fjord-synthetic-repo";

/// What a fixture directory is meant to contain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fixture {
    pub kind: &'static str,
    parameters: BTreeMap<String, String>,
}

/// Whether the caller must generate the fixture, or may use what is on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preparation {
    Generate,
    Reuse,
}

impl Fixture {
    pub fn new(kind: &'static str) -> Self {
        Self {
            kind,
            parameters: BTreeMap::new(),
        }
    }

    pub fn with(mut self, name: &str, value: impl ToString) -> Self {
        self.parameters.insert(name.to_string(), value.to_string());
        self
    }

    /// Canonical JSON: keys sorted by `BTreeMap`, no incidental whitespace, so
    /// the same fixture always serializes and hashes identically.
    pub fn to_json(&self) -> String {
        let parameters = self
            .parameters
            .iter()
            .map(|(key, value)| format!("{}:{}", json_string(key), json_string(value)))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"schemaVersion\":{},\"kind\":{},\"parameters\":{{{}}}}}",
            SCHEMA_VERSION,
            json_string(self.kind),
            parameters
        )
    }

    /// Short stable digest of the canonical form, recorded alongside every
    /// measurement so a result can be traced to the fixture that produced it.
    /// FNV-1a rather than a hashing crate: this identifies a fixture, it does
    /// not defend against anyone.
    pub fn hash(&self) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in self.to_json().as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{hash:016x}")
    }
}

/// Decides whether `path` can be reused for `fixture`, preparing the directory
/// when it cannot.
///
/// Returns [`Preparation::Reuse`] only when the directory holds a manifest
/// identical to `fixture` and `force` is not set. Any other state leaves an
/// empty directory ready for generation — except a directory that is not ours,
/// which is an error rather than a deletion.
pub fn prepare(path: &Path, fixture: &Fixture, force: bool) -> Result<Preparation, String> {
    if !path.exists() {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
        return Ok(Preparation::Generate);
    }

    if is_empty_dir(path)? {
        return Ok(Preparation::Generate);
    }

    if !ours(path) {
        return Err(format!(
            "refusing to use {}: it is not a generated fixture (no {MANIFEST_FILE} or {MARKER_FILE}). \
             Choose another path.",
            path.display()
        ));
    }

    if !force {
        if let Some(existing) = read_manifest(path) {
            if existing == fixture.to_json() {
                return Ok(Preparation::Reuse);
            }
            eprintln!(
                "fixture at {} was generated with different parameters; regenerating",
                path.display()
            );
        } else {
            eprintln!(
                "fixture at {} has no manifest; regenerating so its parameters are known",
                path.display()
            );
        }
    }

    fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    Ok(Preparation::Generate)
}

/// Marks a freshly generated directory. Written last, so an interrupted
/// generation leaves a directory that regenerates rather than one that claims
/// to be complete.
pub fn write(path: &Path, fixture: &Fixture) -> Result<(), String> {
    fs::write(path.join(MARKER_FILE), "generated by fjord-bench\n").map_err(|e| e.to_string())?;
    fs::write(path.join(MANIFEST_FILE), fixture.to_json()).map_err(|e| e.to_string())
}

fn read_manifest(path: &Path) -> Option<String> {
    fs::read_to_string(path.join(MANIFEST_FILE)).ok()
}

fn ours(path: &Path) -> bool {
    path.join(MANIFEST_FILE).exists() || path.join(MARKER_FILE).exists()
}

fn is_empty_dir(path: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    Ok(entries.next().is_none())
}

/// Minimal JSON string escaping. Fixture parameters are numbers and short
/// identifiers, but a path could carry a backslash on Windows.
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
    use std::fs;
    use tempfile::TempDir;

    fn repo_fixture(commits: usize) -> Fixture {
        Fixture::new("repo")
            .with("commits", commits)
            .with("files", 50)
    }

    #[test]
    fn canonical_json_is_order_independent() {
        let one = Fixture::new("repo").with("commits", 10).with("files", 2);
        let two = Fixture::new("repo").with("files", 2).with("commits", 10);

        assert_eq!(one.to_json(), two.to_json());
        assert_eq!(one.hash(), two.hash());
    }

    #[test]
    fn different_parameters_hash_differently() {
        assert_ne!(repo_fixture(10).hash(), repo_fixture(11).hash());
    }

    #[test]
    fn json_escapes_windows_paths() {
        let fixture = Fixture::new("repo").with("root", r"C:\repos\fjord");
        assert!(fixture.to_json().contains(r"C:\\repos\\fjord"));
    }

    #[test]
    fn a_missing_directory_is_generated() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fixture");

        assert_eq!(
            prepare(&path, &repo_fixture(10), false).unwrap(),
            Preparation::Generate
        );
        assert!(path.exists());
    }

    #[test]
    fn a_matching_manifest_is_reused() {
        let dir = TempDir::new().unwrap();
        let fixture = repo_fixture(10);
        fs::write(dir.path().join("payload"), b"generated").unwrap();
        write(dir.path(), &fixture).unwrap();

        assert_eq!(
            prepare(dir.path(), &fixture, false).unwrap(),
            Preparation::Reuse
        );
        assert!(
            dir.path().join("payload").exists(),
            "a reused fixture must not be deleted"
        );
    }

    /// The bug this module exists for: the old check saw a `.git` directory and
    /// reused a 200-commit fixture for a 50 000-commit run.
    #[test]
    fn changed_parameters_force_regeneration() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("payload"), b"generated").unwrap();
        write(dir.path(), &repo_fixture(200)).unwrap();

        assert_eq!(
            prepare(dir.path(), &repo_fixture(50_000), false).unwrap(),
            Preparation::Generate
        );
        assert!(
            !dir.path().join("payload").exists(),
            "a stale fixture must be cleared before regeneration"
        );
    }

    #[test]
    fn force_regenerates_a_matching_fixture() {
        let dir = TempDir::new().unwrap();
        let fixture = repo_fixture(10);
        fs::write(dir.path().join("payload"), b"generated").unwrap();
        write(dir.path(), &fixture).unwrap();

        assert_eq!(
            prepare(dir.path(), &fixture, true).unwrap(),
            Preparation::Generate
        );
        assert!(!dir.path().join("payload").exists());
    }

    /// An older fixture predates manifests. Regenerate it rather than trusting
    /// parameters nobody recorded.
    #[test]
    fn a_marked_fixture_without_a_manifest_regenerates() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(MARKER_FILE), b"old\n").unwrap();
        fs::write(dir.path().join("payload"), b"generated").unwrap();

        assert_eq!(
            prepare(dir.path(), &repo_fixture(10), false).unwrap(),
            Preparation::Generate
        );
        assert!(!dir.path().join("payload").exists());
    }

    #[test]
    fn a_directory_we_did_not_create_is_never_deleted() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("important.txt"), b"user data").unwrap();

        for force in [false, true] {
            let error = prepare(dir.path(), &repo_fixture(10), force)
                .expect_err("an unmarked directory must be refused");
            assert!(
                error.contains("refusing to use"),
                "unexpected error: {error}"
            );
        }
        assert!(
            dir.path().join("important.txt").exists(),
            "user data must survive both flag settings"
        );
    }

    #[test]
    fn an_empty_directory_is_usable_without_a_marker() {
        let dir = TempDir::new().unwrap();

        assert_eq!(
            prepare(dir.path(), &repo_fixture(10), false).unwrap(),
            Preparation::Generate
        );
    }
}
