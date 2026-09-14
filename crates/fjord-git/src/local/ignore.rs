use std::io::Write;
use std::path::Path;

use fjord_domain::{IgnoreRuleKind, IgnoreRuleOutcome, IgnoreRulePreview};
use fjord_ports::{GitError, RepoPath};

use super::{LocalGitBackend, MutationKind};

const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

pub(super) async fn preview(
    repo: &RepoPath,
    path: &str,
    kind: IgnoreRuleKind,
) -> Result<IgnoreRulePreview, GitError> {
    let _guard = LocalGitBackend::acquire_repo_read_lock(repo).await;
    ensure_untracked(repo, path)?;
    preview_unlocked(repo, path, kind)
}

pub(super) async fn add(
    repo: &RepoPath,
    path: &str,
    kind: IgnoreRuleKind,
) -> Result<IgnoreRuleOutcome, GitError> {
    let _guard = LocalGitBackend::acquire_repo_write_lock(repo).await;
    ensure_untracked(repo, path)?;
    let rule = build_rule(path, kind)?;
    let ignore_path = repo.0.join(".gitignore");
    let mut lock = gix_lock::File::acquire_to_update_resource(
        &ignore_path,
        gix_lock::acquire::Fail::Immediately,
        None,
    )
    .map_err(|error| GitError::IgnoreWriteFailed(error.to_string()))?;
    // Read only after owning `.gitignore.lock`, so another lock-honoring writer
    // cannot land unrelated bytes between our read and publication.
    let original = read_ignore_file(&ignore_path)?;
    let text = decode_ignore_file(&original)?;
    if contains_rule(text, &rule) {
        return Ok(IgnoreRuleOutcome::AlreadyPresent);
    }
    let updated = append_rule(&original, &rule)?;
    lock.write_all(&updated)
        .and_then(|()| lock.flush())
        .map_err(|error| GitError::IgnoreWriteFailed(error.to_string()))?;
    let marker = lock
        .close()
        .map_err(|error| GitError::IgnoreWriteFailed(error.to_string()))?;
    marker
        .commit()
        .map_err(|error| GitError::IgnoreWriteFailed(error.to_string()))?;
    super::runtime::bump_mutation(repo, MutationKind::Ignore);
    Ok(IgnoreRuleOutcome::Added)
}

fn ensure_untracked(repo: &RepoPath, path: &str) -> Result<(), GitError> {
    LocalGitBackend::with_runtime_git2(repo, |git| {
        let index = LocalGitBackend::fresh_index(git)?;
        if index.get_path(Path::new(path), 0).is_some() {
            Err(GitError::IgnoreRuleUnsupportedForTrackedFile(
                path.to_string(),
            ))
        } else {
            Ok(())
        }
    })
}

fn preview_unlocked(
    repo: &RepoPath,
    path: &str,
    kind: IgnoreRuleKind,
) -> Result<IgnoreRulePreview, GitError> {
    let rule = build_rule(path, kind)?;
    let bytes = read_ignore_file(&repo.0.join(".gitignore"))?;
    let text = decode_ignore_file(&bytes)?;
    Ok(IgnoreRulePreview {
        already_present: contains_rule(text, &rule),
        rule,
    })
}

fn build_rule(path: &str, kind: IgnoreRuleKind) -> Result<String, GitError> {
    match kind {
        IgnoreRuleKind::File => Ok(format!("/{path}")),
        IgnoreRuleKind::Extension => Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .filter(|extension| !extension.is_empty())
            .map(|extension| format!("*.{extension}"))
            .ok_or_else(|| {
                GitError::IgnoreWriteFailed("the selected file has no extension".into())
            }),
        IgnoreRuleKind::Directory => path
            .rsplit_once('/')
            .map(|(directory, _)| directory)
            .filter(|directory| !directory.is_empty())
            .map(|directory| format!("/{directory}/"))
            .ok_or_else(|| {
                GitError::IgnoreWriteFailed("the selected file is at the repository root".into())
            }),
    }
}

fn read_ignore_file(path: &Path) -> Result<Vec<u8>, GitError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(GitError::IgnoreWriteFailed(error.to_string())),
    }
}

fn decode_ignore_file(bytes: &[u8]) -> Result<&str, GitError> {
    let text = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    std::str::from_utf8(text).map_err(|_| GitError::IgnoreFileEncodingUnsupported)
}

fn contains_rule(text: &str, rule: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim();
        !trimmed.starts_with('#') && !trimmed.starts_with('!') && trimmed == rule
    })
}

fn append_rule(original: &[u8], rule: &str) -> Result<Vec<u8>, GitError> {
    decode_ignore_file(original)?;
    let terminator = dominant_terminator(original);
    let mut updated = original.to_vec();
    if !updated.is_empty() && !updated.ends_with(b"\n") {
        updated.extend_from_slice(terminator);
    }
    updated.extend_from_slice(rule.as_bytes());
    updated.extend_from_slice(terminator);
    Ok(updated)
}

fn dominant_terminator(bytes: &[u8]) -> &'static [u8] {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf {
        b"\r\n"
    } else {
        b"\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_are_anchored_and_only_exist_for_supported_path_shapes() {
        assert_eq!(
            build_rule("src/generated/debug.log", IgnoreRuleKind::File).unwrap(),
            "/src/generated/debug.log"
        );
        assert_eq!(
            build_rule("src/generated/debug.log", IgnoreRuleKind::Extension).unwrap(),
            "*.log"
        );
        assert_eq!(
            build_rule("src/generated/debug.log", IgnoreRuleKind::Directory).unwrap(),
            "/src/generated/"
        );
        assert!(build_rule("README", IgnoreRuleKind::Extension).is_err());
        assert!(build_rule("README", IgnoreRuleKind::Directory).is_err());
    }

    #[test]
    fn append_preserves_encoding_bom_terminators_and_unrelated_bytes() {
        let cases: &[(&[u8], &[u8])] = &[
            (b"first\n", b"first\n/new.txt\n"),
            (b"first\r\nsecond\r\n", b"first\r\nsecond\r\n/new.txt\r\n"),
            (b"first", b"first\n/new.txt\n"),
            (b"", b"/new.txt\n"),
            (b"\xef\xbb\xbffirst\n", b"\xef\xbb\xbffirst\n/new.txt\n"),
        ];
        for (input, expected) in cases {
            assert_eq!(append_rule(input, "/new.txt").unwrap(), *expected);
        }
    }

    #[test]
    fn duplicate_detection_ignores_comments_and_negations_and_invalid_utf8_fails_closed() {
        assert!(contains_rule("# /file.txt\n/file.txt\n", "/file.txt"));
        assert!(!contains_rule("# /file.txt\n!/file.txt\n", "/file.txt"));
        assert!(matches!(
            append_rule(&[0xff, 0xfe], "/file.txt"),
            Err(GitError::IgnoreFileEncodingUnsupported)
        ));
    }
}
