//! Deterministic, read-only construction of minimal unified patches.
//!
//! Keeping verification and construction here lets every patch mutation share
//! one fail-closed implementation without accepting caller-supplied patch text.

use std::collections::{BTreeMap, BTreeSet};

use fjord_domain::{
    DiffHunk, DiffLine, DiffLineEnding, DiffLineKind, FileChangeType, FileDiffDetail,
    HunkSelection, PatchSelection, PatchSource,
};
use fjord_ports::GitError;
use sha2::{Digest, Sha256};

type HunkCoordinates = (u32, u32, u32, u32);

pub(super) fn base_digest(diff: &FileDiffDetail, source: PatchSource) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fjord-rendered-patch-v1\0");
    hash_bytes(&mut digest, diff.path.as_bytes());
    digest.update([match source {
        PatchSource::Worktree => 0,
        PatchSource::Index => 1,
    }]);
    digest.update([match diff.change_type {
        FileChangeType::Added => 0,
        FileChangeType::Modified => 1,
        FileChangeType::Deleted => 2,
        FileChangeType::Renamed => 3,
    }]);
    hash_optional_u32(&mut digest, diff.old_mode);
    hash_optional_u32(&mut digest, diff.new_mode);
    digest.update([u8::from(diff.is_binary)]);
    hash_u32(&mut digest, diff.hunks.len() as u32);

    for hunk in &diff.hunks {
        hash_u32(&mut digest, hunk.old_start);
        hash_u32(&mut digest, hunk.old_lines);
        hash_u32(&mut digest, hunk.new_start);
        hash_u32(&mut digest, hunk.new_lines);
        hash_u32(&mut digest, hunk.lines.len() as u32);
        for line in &hunk.lines {
            digest.update([match line.kind {
                DiffLineKind::Context => 0,
                DiffLineKind::Addition => 1,
                DiffLineKind::Deletion => 2,
            }]);
            hash_optional_u32(&mut digest, line.old_lineno);
            hash_optional_u32(&mut digest, line.new_lineno);
            hash_bytes(&mut digest, line.content.as_bytes());
            digest.update([match line.line_ending {
                None => 0,
                Some(DiffLineEnding::Lf) => 1,
                Some(DiffLineEnding::Crlf) => 2,
                Some(DiffLineEnding::None) => 3,
            }]);
        }
    }

    let bytes = digest.finalize();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

/// Verifies `selection` against `diff` and constructs only its selected hunks.
/// No repository state is read or mutated by this function.
pub(super) fn build_unified_patch(
    diff: &FileDiffDetail,
    selection: &PatchSelection,
) -> Result<Vec<u8>, GitError> {
    build_unified_patch_with_direction(diff, selection, PatchDirection::Forward)
}

/// Builds a selected patch in the orientation required by `git apply
/// --reverse`: its context is the diff's current/new side, so unrelated
/// changes in the same hunk remain intact when Git reverses only the selected
/// changes. This is used for both index unstaging and worktree discard.
pub(super) fn build_unified_reverse_patch(
    diff: &FileDiffDetail,
    selection: &PatchSelection,
) -> Result<Vec<u8>, GitError> {
    let direction = if diff.change_type == FileChangeType::Deleted {
        PatchDirection::ReverseDeletedWorktree
    } else {
        PatchDirection::Reverse
    };
    build_unified_patch_with_direction(diff, selection, direction)
}

#[derive(Clone, Copy)]
enum PatchDirection {
    Forward,
    Reverse,
    /// A worktree deletion reversal starts from an absent file and materializes
    /// only the selected old-side lines.
    ReverseDeletedWorktree,
}

#[derive(Clone, Copy)]
enum FilePatchKind {
    New,
    Deleted,
    Modified,
}

fn build_unified_patch_with_direction(
    diff: &FileDiffDetail,
    selection: &PatchSelection,
    direction: PatchDirection,
) -> Result<Vec<u8>, GitError> {
    if base_digest(diff, selection.source) != selection.base_digest {
        return Err(GitError::PatchStale);
    }
    if selection.path != diff.path {
        return Err(GitError::PatchUnsupported(
            "selection path does not match the rendered diff".to_string(),
        ));
    }
    if diff.is_binary {
        return Err(GitError::PatchUnsupported(
            "binary changes have no line representation".to_string(),
        ));
    }
    if diff.change_type == FileChangeType::Renamed {
        return Err(GitError::PatchUnsupported(
            "renamed files require old-path metadata".to_string(),
        ));
    }
    if diff.hunks.is_empty() || selection.hunks.is_empty() {
        return Err(GitError::PatchUnsupported(
            "the change has no selected line hunks".to_string(),
        ));
    }

    let selected = indexed_selections(&selection.hunks)?;
    let whole_file = is_whole_file_selection(diff, &selected);
    let patch_kind = patch_kind(diff.change_type, direction, whole_file);
    let mut seen = BTreeSet::new();
    let mut rendered_hunks = Vec::new();
    let mut selected_delta = 0_i64;

    for hunk in &diff.hunks {
        let coordinates = coordinates(hunk);
        let Some(hunk_selection) = selected.get(&coordinates) else {
            continue;
        };
        seen.insert(coordinates);
        let rendered = render_hunk(hunk, hunk_selection, selected_delta, direction)?;
        selected_delta += i64::from(rendered.new_lines) - i64::from(rendered.old_lines);
        rendered_hunks.push(rendered);
    }

    if seen.len() != selected.len() {
        return Err(GitError::PatchUnsupported(
            "one or more selected hunk coordinates are not present".to_string(),
        ));
    }

    let old_path = match patch_kind {
        FilePatchKind::New => "/dev/null".to_string(),
        _ => quote_patch_path("a/", &diff.path),
    };
    let new_path = match patch_kind {
        FilePatchKind::Deleted => "/dev/null".to_string(),
        _ => quote_patch_path("b/", &diff.path),
    };
    let mut patch = Vec::new();
    extend_line(
        &mut patch,
        format!(
            "diff --git {} {}",
            quote_patch_path("a/", &diff.path),
            quote_patch_path("b/", &diff.path)
        )
        .as_bytes(),
    );
    match patch_kind {
        FilePatchKind::New => {
            let mode = diff.new_mode.ok_or_else(|| {
                GitError::PatchUnsupported("added file mode is unavailable".to_string())
            })?;
            extend_line(&mut patch, format!("new file mode {mode:06o}").as_bytes());
        }
        FilePatchKind::Deleted => {
            let mode = diff.old_mode.ok_or_else(|| {
                GitError::PatchUnsupported("deleted file mode is unavailable".to_string())
            })?;
            extend_line(
                &mut patch,
                format!("deleted file mode {mode:06o}").as_bytes(),
            );
        }
        FilePatchKind::Modified => {}
    }
    extend_line(&mut patch, format!("--- {old_path}").as_bytes());
    extend_line(&mut patch, format!("+++ {new_path}").as_bytes());
    for hunk in rendered_hunks {
        extend_line(
            &mut patch,
            format!(
                "@@ -{} +{} @@",
                format_range(hunk.old_start, hunk.old_lines),
                format_range(hunk.new_start, hunk.new_lines)
            )
            .as_bytes(),
        );
        for line in hunk.lines {
            patch.push(line.prefix);
            patch.extend_from_slice(line.line.content.as_bytes());
            match line.line.line_ending.ok_or_else(|| {
                GitError::PatchUnsupported("line-ending metadata is unavailable".to_string())
            })? {
                DiffLineEnding::Lf => patch.push(b'\n'),
                DiffLineEnding::Crlf => patch.extend_from_slice(b"\r\n"),
                DiffLineEnding::None => {
                    patch.push(b'\n');
                    patch.extend_from_slice(b"\\ No newline at end of file\n");
                }
            }
        }
    }
    Ok(patch)
}

fn is_whole_file_selection(
    diff: &FileDiffDetail,
    selected: &BTreeMap<HunkCoordinates, &HunkSelection>,
) -> bool {
    selected.len() == diff.hunks.len()
        && diff.hunks.iter().all(|hunk| {
            selected
                .get(&coordinates(hunk))
                .is_some_and(|selection| selection.lines.is_empty())
        })
        && match diff.change_type {
            FileChangeType::Added => diff
                .hunks
                .iter()
                .flat_map(|hunk| &hunk.lines)
                .all(|line| line.kind == DiffLineKind::Addition),
            FileChangeType::Deleted => diff
                .hunks
                .iter()
                .flat_map(|hunk| &hunk.lines)
                .all(|line| line.kind == DiffLineKind::Deletion),
            FileChangeType::Modified | FileChangeType::Renamed => true,
        }
}

fn patch_kind(
    change_type: FileChangeType,
    direction: PatchDirection,
    whole_file: bool,
) -> FilePatchKind {
    match (change_type, direction, whole_file) {
        // A new-file patch can safely stage a selected subset from an
        // untracked file: the index contains just that subset and Git leaves
        // the worktree alone.
        (FileChangeType::Added, PatchDirection::Forward, _) => FilePatchKind::New,
        // Reversing an added-file selection runs against a populated index or
        // worktree. Only the complete selection may use `/dev/null`; a partial
        // one must be a modified-file patch so it removes only selected lines.
        (FileChangeType::Added, PatchDirection::Reverse, true) => FilePatchKind::New,
        (FileChangeType::Added, PatchDirection::Reverse, false) => FilePatchKind::Modified,
        (FileChangeType::Added, PatchDirection::ReverseDeletedWorktree, _) => {
            unreachable!("reverse-deleted direction is only used for deleted files")
        }
        // A whole deleted file is represented canonically. Staging only part
        // of its deletion runs against a populated index, so use normal file
        // headers and preserve unselected lines as context.
        (FileChangeType::Deleted, PatchDirection::Forward, true) => FilePatchKind::Deleted,
        (FileChangeType::Deleted, PatchDirection::Forward, false) => FilePatchKind::Modified,
        // Reverse deleted-file application begins at an absent target. The
        // selected old-side lines form the exact file content to restore.
        (FileChangeType::Deleted, PatchDirection::ReverseDeletedWorktree, _) => {
            FilePatchKind::Deleted
        }
        (FileChangeType::Deleted, PatchDirection::Reverse, _) => {
            unreachable!("deleted files select an explicit reverse direction")
        }
        (FileChangeType::Modified, _, _) => FilePatchKind::Modified,
        (FileChangeType::Renamed, _, _) => unreachable!("renames are rejected above"),
    }
}

struct RenderedHunk<'a> {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    lines: Vec<RenderedLine<'a>>,
}

struct RenderedLine<'a> {
    prefix: u8,
    line: &'a DiffLine,
}

fn render_hunk<'a>(
    hunk: &'a DiffHunk,
    selection: &HunkSelection,
    selected_delta_before: i64,
    direction: PatchDirection,
) -> Result<RenderedHunk<'a>, GitError> {
    let selected_lines = if selection.lines.is_empty() {
        None
    } else {
        let mut lines = BTreeSet::new();
        for index in &selection.lines {
            let line = hunk.lines.get(*index as usize).ok_or_else(|| {
                GitError::PatchUnsupported("selected line index is outside its hunk".to_string())
            })?;
            if line.kind == DiffLineKind::Context {
                return Err(GitError::PatchUnsupported(
                    "context lines cannot be selected as changes".to_string(),
                ));
            }
            lines.insert(*index);
        }
        Some(lines)
    };

    let mut lines = Vec::with_capacity(hunk.lines.len());
    let mut selected_changes = 0_u32;
    for (index, line) in hunk.lines.iter().enumerate() {
        let is_selected = selected_lines
            .as_ref()
            .is_none_or(|selected| selected.contains(&(index as u32)));
        match (line.kind, is_selected, direction) {
            (DiffLineKind::Context, _, _) => lines.push(RenderedLine { prefix: b' ', line }),
            (DiffLineKind::Addition, true, _) => {
                selected_changes += 1;
                lines.push(RenderedLine { prefix: b'+', line });
            }
            (DiffLineKind::Deletion, true, PatchDirection::Forward | PatchDirection::Reverse) => {
                selected_changes += 1;
                lines.push(RenderedLine { prefix: b'-', line });
            }
            // An unselected added line does not exist in the patch base.
            (DiffLineKind::Addition, false, PatchDirection::Forward) => {}
            // An unselected deletion must remain unchanged, so it becomes
            // context in the partial patch.
            (DiffLineKind::Deletion, false, PatchDirection::Forward) => {
                lines.push(RenderedLine { prefix: b' ', line });
            }
            // `--reverse` sees the patch's new side as the current index.
            // Keep unselected additions as index context and omit deletions
            // that are absent from both index sides.
            (DiffLineKind::Addition, false, PatchDirection::Reverse) => {
                lines.push(RenderedLine { prefix: b' ', line });
            }
            (DiffLineKind::Deletion, false, PatchDirection::Reverse) => {}
            // The new side of a deleted-file patch is `/dev/null`; omitted
            // deletion lines cannot be context. Keeping them would make
            // `git apply --reverse` require bytes that are intentionally
            // absent and would turn this known case into an apply failure.
            (DiffLineKind::Addition, _, PatchDirection::ReverseDeletedWorktree) => {
                return Err(GitError::PatchUnsupported(
                    "deleted-file diff contains an added line".to_string(),
                ));
            }
            (DiffLineKind::Deletion, true, PatchDirection::ReverseDeletedWorktree) => {
                selected_changes += 1;
                lines.push(RenderedLine { prefix: b'-', line });
            }
            (DiffLineKind::Deletion, false, PatchDirection::ReverseDeletedWorktree) => {}
        }
    }
    if selected_changes == 0 {
        return Err(GitError::PatchUnsupported(
            "the selected hunk contains no changed lines".to_string(),
        ));
    }

    let old_lines = lines.iter().filter(|line| line.prefix != b'+').count() as u32;
    let new_lines = lines.iter().filter(|line| line.prefix != b'-').count() as u32;
    let (old_start, new_start) = match direction {
        PatchDirection::Forward => {
            let mut new_start = i64::from(hunk.old_start) + selected_delta_before;
            if old_lines == 0 {
                new_start += 1;
            } else if new_lines == 0 {
                new_start -= 1;
            }
            let new_start = u32::try_from(new_start.max(0)).map_err(|_| {
                GitError::PatchUnsupported("selected hunk coordinates overflow".to_string())
            })?;
            (hunk.old_start, new_start)
        }
        PatchDirection::Reverse => {
            let mut old_start = i64::from(hunk.new_start) - selected_delta_before;
            if old_lines == 0 {
                old_start += 1;
            } else if new_lines == 0 {
                old_start -= 1;
            }
            let old_start = u32::try_from(old_start.max(0)).map_err(|_| {
                GitError::PatchUnsupported("selected hunk coordinates overflow".to_string())
            })?;
            (old_start, hunk.new_start)
        }
        PatchDirection::ReverseDeletedWorktree => {
            let mut new_start = i64::from(hunk.old_start) + selected_delta_before;
            if old_lines == 0 {
                new_start += 1;
            } else if new_lines == 0 {
                new_start -= 1;
            }
            let new_start = u32::try_from(new_start.max(0)).map_err(|_| {
                GitError::PatchUnsupported("selected hunk coordinates overflow".to_string())
            })?;
            (hunk.old_start, new_start)
        }
    };

    Ok(RenderedHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines,
    })
}

fn indexed_selections(
    selections: &[HunkSelection],
) -> Result<BTreeMap<HunkCoordinates, &HunkSelection>, GitError> {
    let mut indexed = BTreeMap::new();
    for selection in selections {
        let key = (
            selection.old_start,
            selection.old_lines,
            selection.new_start,
            selection.new_lines,
        );
        if indexed.insert(key, selection).is_some() {
            return Err(GitError::PatchUnsupported(
                "the same hunk was selected more than once".to_string(),
            ));
        }
    }
    Ok(indexed)
}

fn coordinates(hunk: &DiffHunk) -> HunkCoordinates {
    (
        hunk.old_start,
        hunk.old_lines,
        hunk.new_start,
        hunk.new_lines,
    )
}

fn format_range(start: u32, lines: u32) -> String {
    if lines == 1 {
        start.to_string()
    } else {
        format!("{start},{lines}")
    }
}

fn extend_line(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(value);
    output.push(b'\n');
}

fn quote_patch_path(prefix: &str, path: &str) -> String {
    let value = format!("{prefix}{path}");
    if value
        .bytes()
        .all(|byte| byte.is_ascii_graphic() && !matches!(byte, b'"' | b'\\'))
    {
        return value;
    }
    let mut quoted = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

fn hash_bytes(digest: &mut Sha256, value: &[u8]) {
    hash_u32(digest, value.len() as u32);
    digest.update(value);
}

fn hash_u32(digest: &mut Sha256, value: u32) {
    digest.update(value.to_le_bytes());
}

fn hash_optional_u32(digest: &mut Sha256, value: Option<u32>) {
    match value {
        Some(value) => {
            digest.update([1]);
            hash_u32(digest, value);
        }
        None => digest.update([0]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOB_MODE: u32 = 0o100644;

    fn line(
        kind: DiffLineKind,
        old_lineno: Option<u32>,
        new_lineno: Option<u32>,
        content: &str,
    ) -> DiffLine {
        DiffLine {
            kind,
            old_lineno,
            new_lineno,
            content: content.to_string(),
            line_ending: Some(DiffLineEnding::Lf),
        }
    }

    fn modified_diff() -> FileDiffDetail {
        FileDiffDetail {
            path: "src/main.rs".to_string(),
            change_type: FileChangeType::Modified,
            old_mode: Some(BLOB_MODE),
            new_mode: Some(BLOB_MODE),
            is_binary: false,
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 3,
                lines: vec![
                    line(DiffLineKind::Context, Some(1), Some(1), "before"),
                    line(DiffLineKind::Deletion, Some(2), None, "old"),
                    line(DiffLineKind::Addition, None, Some(2), "new"),
                    line(DiffLineKind::Context, Some(3), Some(3), "after"),
                ],
            }],
        }
    }

    fn selection(diff: &FileDiffDetail, lines: Vec<u32>) -> PatchSelection {
        let hunk = &diff.hunks[0];
        PatchSelection {
            path: diff.path.clone(),
            source: PatchSource::Worktree,
            hunks: vec![HunkSelection {
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                lines,
            }],
            base_digest: base_digest(diff, PatchSource::Worktree),
        }
    }

    fn patch_text(diff: &FileDiffDetail, selection: PatchSelection) -> String {
        String::from_utf8(build_unified_patch(diff, &selection).unwrap()).unwrap()
    }

    fn staged_selection(diff: &FileDiffDetail, lines: Vec<u32>) -> PatchSelection {
        let mut selection = selection(diff, lines);
        selection.source = PatchSource::Index;
        selection.base_digest = base_digest(diff, PatchSource::Index);
        selection
    }

    #[test]
    fn whole_hunk_preserves_context_additions_and_deletions() {
        let diff = modified_diff();
        let patch = patch_text(&diff, selection(&diff, Vec::new()));

        assert!(patch.contains("@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n"));
    }

    #[test]
    fn selecting_one_line_keeps_unselected_deletion_as_context() {
        let diff = modified_diff();
        let patch = patch_text(&diff, selection(&diff, vec![2]));

        assert!(patch.contains("@@ -1,3 +1,4 @@\n before\n old\n+new\n after\n"));
        assert!(!patch.contains("-old"));
    }

    #[test]
    fn reverse_patch_keeps_unselected_staged_additions_as_index_context() {
        let diff = FileDiffDetail {
            path: "file.txt".into(),
            change_type: FileChangeType::Modified,
            old_mode: Some(BLOB_MODE),
            new_mode: Some(BLOB_MODE),
            is_binary: false,
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 5,
                new_start: 1,
                new_lines: 5,
                lines: vec![
                    line(DiffLineKind::Context, Some(1), Some(1), "before"),
                    line(DiffLineKind::Deletion, Some(2), None, "old one"),
                    line(DiffLineKind::Addition, None, Some(2), "new one"),
                    line(DiffLineKind::Context, Some(3), Some(3), "middle"),
                    line(DiffLineKind::Deletion, Some(4), None, "old two"),
                    line(DiffLineKind::Addition, None, Some(4), "new two"),
                    line(DiffLineKind::Context, Some(5), Some(5), "after"),
                ],
            }],
        };
        let patch = String::from_utf8(
            build_unified_reverse_patch(&diff, &staged_selection(&diff, vec![1, 2])).unwrap(),
        )
        .unwrap();

        assert!(patch.contains("-old one\n+new one\n middle\n new two\n after\n"));
        assert!(!patch.contains("-old two"));
        assert!(!patch.contains("+new two"));
    }

    #[test]
    fn first_and_last_changed_lines_are_addressed_by_hunk_line_index() {
        let mut diff = modified_diff();
        diff.hunks[0]
            .lines
            .insert(0, line(DiffLineKind::Addition, None, Some(1), "first"));
        diff.hunks[0]
            .lines
            .push(line(DiffLineKind::Deletion, Some(4), None, "last"));
        diff.hunks[0].old_lines = 4;
        diff.hunks[0].new_lines = 4;
        let last = diff.hunks[0].lines.len() as u32 - 1;
        let patch = patch_text(&diff, selection(&diff, vec![0, last]));

        assert!(patch.contains("+first"));
        assert!(patch.contains("-last"));
        assert!(!patch.contains("+new"));
    }

    #[test]
    fn selection_order_does_not_change_patch_representation() {
        let mut diff = modified_diff();
        diff.hunks.push(DiffHunk {
            old_start: 20,
            old_lines: 1,
            new_start: 20,
            new_lines: 1,
            lines: vec![
                line(DiffLineKind::Deletion, Some(20), None, "old two"),
                line(DiffLineKind::Addition, None, Some(20), "new two"),
            ],
        });
        let first = &diff.hunks[0];
        let second = &diff.hunks[1];
        let hunk = |value: &DiffHunk| HunkSelection {
            old_start: value.old_start,
            old_lines: value.old_lines,
            new_start: value.new_start,
            new_lines: value.new_lines,
            lines: Vec::new(),
        };
        let make = |hunks| PatchSelection {
            path: diff.path.clone(),
            source: PatchSource::Worktree,
            hunks,
            base_digest: base_digest(&diff, PatchSource::Worktree),
        };

        let forward = build_unified_patch(&diff, &make(vec![hunk(first), hunk(second)])).unwrap();
        let reverse = build_unified_patch(&diff, &make(vec![hunk(second), hunk(first)])).unwrap();
        assert_eq!(forward, reverse);
    }

    #[test]
    fn crlf_and_missing_final_newline_are_preserved() {
        let mut diff = modified_diff();
        for line in &mut diff.hunks[0].lines {
            line.line_ending = Some(DiffLineEnding::Crlf);
        }
        diff.hunks[0].lines.last_mut().unwrap().line_ending = Some(DiffLineEnding::None);
        let patch = build_unified_patch(&diff, &selection(&diff, Vec::new())).unwrap();

        assert!(patch
            .windows(b" before\r\n-old\r\n+new\r\n".len())
            .any(|window| { window == b" before\r\n-old\r\n+new\r\n" }));
        assert!(patch.ends_with(b" after\n\\ No newline at end of file\n"));
    }

    #[test]
    fn added_and_deleted_files_use_dev_null_and_preserve_mode() {
        let added = FileDiffDetail {
            path: "new.txt".to_string(),
            change_type: FileChangeType::Added,
            old_mode: None,
            new_mode: Some(BLOB_MODE),
            is_binary: false,
            hunks: vec![DiffHunk {
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: 1,
                lines: vec![line(DiffLineKind::Addition, None, Some(1), "new")],
            }],
        };
        let added_patch = patch_text(&added, selection(&added, Vec::new()));
        assert!(added_patch.contains("new file mode 100644\n--- /dev/null\n+++ b/new.txt"));
        assert!(added_patch.contains("@@ -0,0 +1 @@"));

        let deleted = FileDiffDetail {
            path: "old.txt".to_string(),
            change_type: FileChangeType::Deleted,
            old_mode: Some(BLOB_MODE),
            new_mode: None,
            is_binary: false,
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 1,
                new_start: 0,
                new_lines: 0,
                lines: vec![line(DiffLineKind::Deletion, Some(1), None, "old")],
            }],
        };
        let deleted_patch = patch_text(&deleted, selection(&deleted, Vec::new()));
        assert!(deleted_patch.contains("deleted file mode 100644\n--- a/old.txt\n+++ /dev/null"));
        assert!(deleted_patch.contains("@@ -1 +0,0 @@"));
    }

    #[test]
    fn partial_added_and_deleted_file_patches_use_safe_headers_per_direction() {
        let added = FileDiffDetail {
            path: "added.txt".to_string(),
            change_type: FileChangeType::Added,
            old_mode: None,
            new_mode: Some(BLOB_MODE),
            is_binary: false,
            hunks: vec![DiffHunk {
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: 3,
                lines: vec![
                    line(DiffLineKind::Addition, None, Some(1), "one"),
                    line(DiffLineKind::Addition, None, Some(2), "two"),
                    line(DiffLineKind::Addition, None, Some(3), "three"),
                ],
            }],
        };
        let added_partial = selection(&added, vec![1]);
        let forward =
            String::from_utf8(build_unified_patch(&added, &added_partial).unwrap()).unwrap();
        assert!(forward.contains("new file mode 100644\n--- /dev/null\n+++ b/added.txt"));
        let reverse =
            String::from_utf8(build_unified_reverse_patch(&added, &added_partial).unwrap())
                .unwrap();
        assert!(!reverse.contains("new file mode"));
        assert!(reverse.contains("--- a/added.txt\n+++ b/added.txt"));

        let deleted = FileDiffDetail {
            path: "deleted.txt".to_string(),
            change_type: FileChangeType::Deleted,
            old_mode: Some(BLOB_MODE),
            new_mode: None,
            is_binary: false,
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 3,
                new_start: 0,
                new_lines: 0,
                lines: vec![
                    line(DiffLineKind::Deletion, Some(1), None, "one"),
                    line(DiffLineKind::Deletion, Some(2), None, "two"),
                    line(DiffLineKind::Deletion, Some(3), None, "three"),
                ],
            }],
        };
        let deleted_partial = selection(&deleted, vec![1]);
        let forward =
            String::from_utf8(build_unified_patch(&deleted, &deleted_partial).unwrap()).unwrap();
        assert!(!forward.contains("deleted file mode"));
        assert!(forward.contains("--- a/deleted.txt\n+++ b/deleted.txt"));
        let reverse =
            String::from_utf8(build_unified_reverse_patch(&deleted, &deleted_partial).unwrap())
                .unwrap();
        assert!(reverse.contains("deleted file mode 100644\n--- a/deleted.txt\n+++ /dev/null"));
        assert!(reverse.contains("-two\n"));
    }

    #[test]
    fn digest_is_stable_but_covers_source_content_and_line_endings() {
        let diff = modified_diff();
        assert_eq!(
            base_digest(&diff, PatchSource::Worktree),
            base_digest(&diff, PatchSource::Worktree)
        );
        assert_ne!(
            base_digest(&diff, PatchSource::Worktree),
            base_digest(&diff, PatchSource::Index)
        );
        let mut changed = diff.clone();
        changed.hunks[0].lines[1].content.push('!');
        assert_ne!(
            base_digest(&diff, PatchSource::Worktree),
            base_digest(&changed, PatchSource::Worktree)
        );
        changed = diff.clone();
        changed.hunks[0].lines[1].line_ending = Some(DiffLineEnding::Crlf);
        assert_ne!(
            base_digest(&diff, PatchSource::Worktree),
            base_digest(&changed, PatchSource::Worktree)
        );
    }

    #[test]
    fn digest_mismatch_and_unsupported_states_fail_closed() {
        let diff = modified_diff();
        let mut stale = selection(&diff, Vec::new());
        stale.base_digest = "stale".to_string();
        assert!(matches!(
            build_unified_patch(&diff, &stale),
            Err(GitError::PatchStale)
        ));

        let mut binary = diff.clone();
        binary.is_binary = true;
        let binary_selection = selection(&binary, Vec::new());
        assert!(matches!(
            build_unified_patch(&binary, &binary_selection),
            Err(GitError::PatchUnsupported(_))
        ));

        let mut invalid = selection(&diff, vec![99]);
        invalid.base_digest = base_digest(&diff, PatchSource::Worktree);
        assert!(matches!(
            build_unified_patch(&diff, &invalid),
            Err(GitError::PatchUnsupported(_))
        ));

        let empty_added = FileDiffDetail {
            path: "empty.txt".to_string(),
            change_type: FileChangeType::Added,
            old_mode: None,
            new_mode: Some(BLOB_MODE),
            is_binary: false,
            hunks: Vec::new(),
        };
        let empty_selection = PatchSelection {
            path: empty_added.path.clone(),
            source: PatchSource::Worktree,
            hunks: Vec::new(),
            base_digest: base_digest(&empty_added, PatchSource::Worktree),
        };
        assert!(matches!(
            build_unified_patch(&empty_added, &empty_selection),
            Err(GitError::PatchUnsupported(_))
        ));

        let mut renamed = diff.clone();
        renamed.change_type = FileChangeType::Renamed;
        let renamed_selection = selection(&renamed, Vec::new());
        assert!(matches!(
            build_unified_patch(&renamed, &renamed_selection),
            Err(GitError::PatchUnsupported(_))
        ));
    }
}
