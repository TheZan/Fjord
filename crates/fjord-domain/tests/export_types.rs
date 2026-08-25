use std::fs;
use std::path::Path;

use fjord_domain::{
    AmendInfo, BranchInfo, BulkRepoResult, CloneRepositoryRequest, CloneRepositoryResult, CommitId,
    CommitPage, CommitPushResult, CommitSummary, Consequence, CreateRepositoryRequest,
    CreateRepositoryResult, CreateStashRequest, CreateStashResult, CredentialHelperInfo,
    DestructiveAction, DestructivePreflight, DiffHunk, DiffLine, DiffLineEnding, DiffLineKind,
    DiffWhitespaceMode, DiscardSelection, FileChangeType, FileDiff, FileDiffDetail, FileDiffWindow,
    ForceWithLeaseDetails, GenerationSet, GitAuthPrompt, GitAuthPromptKind, GitConnectionProtocol,
    GitConnectionTestResult, GitEnvironmentInfo, GitExecutable, GitExecutableSource,
    GlobalSearchResult, HunkSelection, IgnoreRuleKind, IgnoreRuleOutcome, IgnoreRulePreview,
    InteractionSpan, InteractionTrace, LogCursor, MergeDirtyPolicy, MergeDirtyState, MergeMode,
    MergeOutcome, MergePrediction, MergePreflight, MergeResult, MergeSource, MergeSourceKind,
    OpenTarget, OperationControl, OverviewUiState, OverviewUiStatePatch, PatchSelection,
    PatchSource, RebaseKind, Recoverability, ReflogEntry, ReflogPage, RemoteInfo, RemotePushResult,
    RemoteRef, RepoOperation, RepoOperationState, RepoStatus, RepoStatusSummary, RepoUiState,
    RepoUiStatePatch, RepositoryEntry, RepositoryFilePath, RepositoryId, RepositorySnapshot,
    ResetMode, SearchResultKind, SelectionUiState, SelectionUiStatePatch, Settings, SidebarUiState,
    SidebarUiStatePatch, SnapshotRevalidation, SquashMergeOutcome, SquashMergeResult, StashEntry,
    StashFileGroup, StashFiles, StashId, StashScope, StoredRepositorySnapshot, TagInfo, Theme,
    UiDiffMode, UiFileViewMode, UiOverviewFilter, UiState, UiStatePatch, WorkingChanges,
    WorkingFile, WorkingFileTarget, Workspace, WorkspaceId,
};
use ts_rs::{Config, TS};

const OUTPUT_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/domain/generated.ts");

fn push<T: TS>(output: &mut String, config: &Config) {
    output.push_str("export ");
    output.push_str(&T::decl(config));
    output.push_str("\n\n");
}

fn push_without_trailing_whitespace<T: TS>(output: &mut String, config: &Config) {
    output.push_str("export ");
    for (index, line) in T::decl(config).lines().enumerate() {
        if index > 0 {
            output.push('\n');
        }
        output.push_str(line.trim_end());
    }
    output.push_str("\n\n");
}

fn generated_types() -> String {
    let config = Config::default();
    let mut output = String::from(
        "// Generated from crates/fjord-domain. Do not edit by hand.\n\
         // Regenerate with: FJORD_UPDATE_DOMAIN_TYPES=1 cargo test -p fjord-domain export_types -- --exact\n\n",
    );

    push::<WorkspaceId>(&mut output, &config);
    push::<RepositoryId>(&mut output, &config);
    push::<Workspace>(&mut output, &config);
    push::<RepositoryEntry>(&mut output, &config);
    push::<CloneRepositoryRequest>(&mut output, &config);
    push::<CloneRepositoryResult>(&mut output, &config);
    push::<CreateRepositoryRequest>(&mut output, &config);
    push::<CreateRepositoryResult>(&mut output, &config);
    push::<RemoteInfo>(&mut output, &config);
    push::<RemotePushResult>(&mut output, &config);
    push::<GenerationSet>(&mut output, &config);
    push::<RepositorySnapshot>(&mut output, &config);
    push::<StoredRepositorySnapshot>(&mut output, &config);
    push::<SnapshotRevalidation>(&mut output, &config);
    push::<RepoStatus>(&mut output, &config);
    push::<RepoStatusSummary>(&mut output, &config);
    push::<OperationControl>(&mut output, &config);
    push::<RebaseKind>(&mut output, &config);
    push::<RepoOperation>(&mut output, &config);
    push::<RepoOperationState>(&mut output, &config);
    push::<BulkRepoResult>(&mut output, &config);
    push::<SearchResultKind>(&mut output, &config);
    push::<GlobalSearchResult>(&mut output, &config);
    push::<BranchInfo>(&mut output, &config);
    push::<MergeSourceKind>(&mut output, &config);
    push::<MergeSource>(&mut output, &config);
    push::<MergeMode>(&mut output, &config);
    push::<MergeDirtyPolicy>(&mut output, &config);
    push_without_trailing_whitespace::<MergePrediction>(&mut output, &config);
    push::<MergeDirtyState>(&mut output, &config);
    push::<MergePreflight>(&mut output, &config);
    push_without_trailing_whitespace::<MergeOutcome>(&mut output, &config);
    push::<MergeResult>(&mut output, &config);
    push_without_trailing_whitespace::<SquashMergeOutcome>(&mut output, &config);
    push::<SquashMergeResult>(&mut output, &config);
    push::<RemoteRef>(&mut output, &config);
    push::<TagInfo>(&mut output, &config);
    push::<StashId>(&mut output, &config);
    push::<StashEntry>(&mut output, &config);
    push::<StashFileGroup>(&mut output, &config);
    push::<StashFiles>(&mut output, &config);
    push_without_trailing_whitespace::<StashScope>(&mut output, &config);
    push::<CreateStashRequest>(&mut output, &config);
    push::<CreateStashResult>(&mut output, &config);
    push::<CommitId>(&mut output, &config);
    push::<CommitSummary>(&mut output, &config);
    push::<LogCursor>(&mut output, &config);
    push::<CommitPage>(&mut output, &config);
    push::<ReflogEntry>(&mut output, &config);
    push::<ReflogPage>(&mut output, &config);
    push::<AmendInfo>(&mut output, &config);
    push::<CommitPushResult>(&mut output, &config);
    push::<FileChangeType>(&mut output, &config);
    push::<FileDiff>(&mut output, &config);
    push_without_trailing_whitespace::<WorkingFile>(&mut output, &config);
    push::<WorkingChanges>(&mut output, &config);
    push_without_trailing_whitespace::<PatchSource>(&mut output, &config);
    push::<WorkingFileTarget>(&mut output, &config);
    push::<RepositoryFilePath>(&mut output, &config);
    push_without_trailing_whitespace::<OpenTarget>(&mut output, &config);
    push::<IgnoreRuleKind>(&mut output, &config);
    push::<IgnoreRulePreview>(&mut output, &config);
    push::<IgnoreRuleOutcome>(&mut output, &config);
    push_without_trailing_whitespace::<HunkSelection>(&mut output, &config);
    push_without_trailing_whitespace::<PatchSelection>(&mut output, &config);
    push::<DiscardSelection>(&mut output, &config);
    push::<ResetMode>(&mut output, &config);
    push::<DestructiveAction>(&mut output, &config);
    push::<ForceWithLeaseDetails>(&mut output, &config);
    push::<Recoverability>(&mut output, &config);
    push::<Consequence>(&mut output, &config);
    push::<DestructivePreflight>(&mut output, &config);
    push::<DiffLineKind>(&mut output, &config);
    push_without_trailing_whitespace::<DiffLineEnding>(&mut output, &config);
    push_without_trailing_whitespace::<DiffLine>(&mut output, &config);
    push::<DiffHunk>(&mut output, &config);
    push_without_trailing_whitespace::<FileDiffDetail>(&mut output, &config);
    push::<DiffWhitespaceMode>(&mut output, &config);
    push_without_trailing_whitespace::<FileDiffWindow>(&mut output, &config);
    push::<Theme>(&mut output, &config);
    push::<GitExecutableSource>(&mut output, &config);
    push::<GitExecutable>(&mut output, &config);
    push::<CredentialHelperInfo>(&mut output, &config);
    push::<GitEnvironmentInfo>(&mut output, &config);
    push::<GitConnectionProtocol>(&mut output, &config);
    push::<GitConnectionTestResult>(&mut output, &config);
    push::<GitAuthPromptKind>(&mut output, &config);
    push::<GitAuthPrompt>(&mut output, &config);
    push::<InteractionSpan>(&mut output, &config);
    push::<InteractionTrace>(&mut output, &config);
    push::<Settings>(&mut output, &config);
    push::<UiDiffMode>(&mut output, &config);
    push::<UiFileViewMode>(&mut output, &config);
    push::<UiOverviewFilter>(&mut output, &config);
    push::<SidebarUiState>(&mut output, &config);
    push::<RepoUiState>(&mut output, &config);
    push::<SelectionUiState>(&mut output, &config);
    push::<OverviewUiState>(&mut output, &config);
    push::<UiState>(&mut output, &config);
    push::<SidebarUiStatePatch>(&mut output, &config);
    push::<RepoUiStatePatch>(&mut output, &config);
    push::<SelectionUiStatePatch>(&mut output, &config);
    push::<OverviewUiStatePatch>(&mut output, &config);
    push::<UiStatePatch>(&mut output, &config);

    output
}

#[test]
fn export_types() {
    let generated = generated_types();
    let path = Path::new(OUTPUT_PATH);

    if std::env::var_os("FJORD_UPDATE_DOMAIN_TYPES").is_some() {
        fs::write(path, generated).expect("generated TypeScript types should be writable");
        return;
    }

    let current = fs::read_to_string(path).expect("generated TypeScript types should exist");
    // Compared with normalized newlines: the file is checked in with LF, but a
    // clone with `core.autocrlf=true` writes CRLF to the working tree, and a
    // line-ending difference says nothing about whether the types are stale.
    assert_eq!(
        normalize_newlines(&current),
        normalize_newlines(&generated),
        "generated TypeScript domain types are stale; run `FJORD_UPDATE_DOMAIN_TYPES=1 cargo test -p fjord-domain export_types -- --exact`"
    );
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}
