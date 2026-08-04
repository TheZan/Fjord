use std::path::Path;

/// Compares two paths the way the underlying filesystem would: case-folded
/// on Windows and macOS (both case-insensitive-but-preserving by default),
/// case-sensitive on Linux. This is the one place that distinction is
/// allowed to exist — see docs/SDD.md §5.4 and docs/specs/data-model.md.
pub fn paths_equal(a: &Path, b: &Path) -> bool {
    if cfg!(target_os = "linux") {
        a == b
    } else {
        let a = a.to_string_lossy().to_lowercase();
        let b = b.to_string_lossy().to_lowercase();
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn identical_paths_are_equal() {
        let p = PathBuf::from("/tmp/fjord/repo");
        assert!(paths_equal(&p, &p));
    }

    #[test]
    fn different_paths_are_not_equal() {
        assert!(!paths_equal(
            &PathBuf::from("/tmp/fjord/repo-a"),
            &PathBuf::from("/tmp/fjord/repo-b")
        ));
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn casing_is_ignored_outside_linux() {
        assert!(paths_equal(
            &PathBuf::from("/Users/dev/Repo"),
            &PathBuf::from("/Users/dev/repo")
        ));
    }
}
