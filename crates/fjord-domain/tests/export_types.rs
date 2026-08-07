use std::fs;
use std::path::Path;

use fjord_domain::{
    BranchInfo, BulkRepoResult, CommitId, CommitPage, CommitSummary, CredentialHelperInfo,
    DiffHunk, DiffLine, DiffLineKind, FileChangeType, FileDiff, FileDiffDetail, GitAuthPrompt,
    GitAuthPromptKind, GitConnectionProtocol, GitConnectionTestResult, GitEnvironmentInfo,
    GitExecutable, GitExecutableSource, GlobalSearchResult, LogCursor, RemoteRef, RepoStatus,
    RepoStatusSummary, RepositoryEntry, RepositoryId, SearchResultKind, Settings, StashEntry,
    TagInfo, Theme, WorkingChanges, WorkingFile, Workspace, WorkspaceId,
};
use ts_rs::{Config, TS};

const OUTPUT_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/domain/generated.ts");

fn push<T: TS>(output: &mut String, config: &Config) {
    output.push_str("export ");
    output.push_str(&T::decl(config));
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
    push::<RepoStatus>(&mut output, &config);
    push::<RepoStatusSummary>(&mut output, &config);
    push::<BulkRepoResult>(&mut output, &config);
    push::<SearchResultKind>(&mut output, &config);
    push::<GlobalSearchResult>(&mut output, &config);
    push::<BranchInfo>(&mut output, &config);
    push::<RemoteRef>(&mut output, &config);
    push::<TagInfo>(&mut output, &config);
    push::<StashEntry>(&mut output, &config);
    push::<CommitId>(&mut output, &config);
    push::<CommitSummary>(&mut output, &config);
    push::<LogCursor>(&mut output, &config);
    push::<CommitPage>(&mut output, &config);
    push::<FileChangeType>(&mut output, &config);
    push::<FileDiff>(&mut output, &config);
    push::<WorkingFile>(&mut output, &config);
    push::<WorkingChanges>(&mut output, &config);
    push::<DiffLineKind>(&mut output, &config);
    push::<DiffLine>(&mut output, &config);
    push::<DiffHunk>(&mut output, &config);
    push::<FileDiffDetail>(&mut output, &config);
    push::<Theme>(&mut output, &config);
    push::<GitExecutableSource>(&mut output, &config);
    push::<GitExecutable>(&mut output, &config);
    push::<CredentialHelperInfo>(&mut output, &config);
    push::<GitEnvironmentInfo>(&mut output, &config);
    push::<GitConnectionProtocol>(&mut output, &config);
    push::<GitConnectionTestResult>(&mut output, &config);
    push::<GitAuthPromptKind>(&mut output, &config);
    push::<GitAuthPrompt>(&mut output, &config);
    push::<Settings>(&mut output, &config);

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
    assert_eq!(
        current, generated,
        "generated TypeScript domain types are stale; run `FJORD_UPDATE_DOMAIN_TYPES=1 cargo test -p fjord-domain export_types -- --exact`"
    );
}
