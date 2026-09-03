//! Real Git bridge for Playwright's existing Tauri boundary fixture.
//! Not part of the shipped binary. Only fixture repositories are passed here.
use fjord_domain::RepositorySnapshot;
use fjord_git::LocalGitBackend;
use fjord_ports::{GitBackend, GitOperationContext, RepoPath};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[tokio::main]
async fn main() {
    let repo = RepoPath::new(std::env::args_os().nth(1).expect("fixture repo").into());
    let backend = LocalGitBackend::new();
    for line in io::stdin().lock().lines() {
        let request: Value =
            serde_json::from_str(&line.expect("request line")).expect("request JSON");
        let result = dispatch(&backend, &repo, &request).await;
        println!(
            "FJORD_E2E:{}",
            match result {
                Ok(value) => json!({"result": value}),
                Err(error) => json!({"error": error.to_string()}),
            }
        );
        io::stdout().flush().unwrap();
    }
}

async fn dispatch(
    backend: &LocalGitBackend,
    repo: &RepoPath,
    request: &Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let args = &request["args"];
    let data = match request["command"].as_str().unwrap() {
        "get_repo_status" => json!(backend.status(repo).await?),
        "get_repo_operation_state" => json!(backend.operation_state(repo).await?),
        "get_branches" => json!(backend.branches(repo).await?),
        "get_commit_files" => json!(
            backend
                .diff_files(repo, args["commitId"].as_str().unwrap())
                .await?
        ),
        "get_tags" => json!(backend.tags(repo).await?),
        "get_commit_log" => json!(backend.log(repo, None, 30).await?),
        "get_working_changes" => json!(backend.working_changes(repo).await?),
        "get_rebase_preflight" => json!(
            backend
                .rebase_preflight(repo, &serde_json::from_value(args["onto"].clone())?)
                .await?
        ),
        "get_stashes" => return Ok(json!(backend.stashes(repo).await?)),
        "list_remotes" => return Ok(json!([])),
        "stash_paths_supported" => return Ok(json!(backend.stash_paths_supported().await?)),
        "diff_tool_availability" => return Ok(json!(false)),
        "get_repository_snapshot" => return Ok(Value::Null),
        "capture_repository_snapshot" | "revalidate_repository_snapshot" => {
            let snapshot = RepositorySnapshot {
                status: backend.status(repo).await?,
                operation_state: backend.operation_state(repo).await?,
                branches: backend.branches(repo).await?,
                tags: backend.tags(repo).await?,
                first_history_page: backend.log(repo, None, 30).await?,
                working_changes: backend.working_changes(repo).await?,
                generations: backend.generations(repo)?,
            };
            return Ok(
                json!({"snapshot": {"repoId": args["repoId"], "snapshot": snapshot,
                "capturedAt": "2026-09-02T00:00:00Z", "validated": true}, "changed": true}),
            );
        }
        "start_rebase" => {
            return Ok(json!(
                backend
                    .start_rebase_preflighted(
                        repo,
                        &serde_json::from_value(args["preflight"].clone())?,
                        serde_json::from_value(args["dirtyPolicy"].clone())?,
                        GitOperationContext::default()
                    )
                    .await?
            ))
        }
        "continue_operation" => return Ok(json!(backend.continue_operation(repo).await?)),
        "open_merge_tool" => {
            backend.open_merge_tool(repo).await?;
            // The real launcher returns immediately. Observe the external tool
            // finishing before serving the fixture's next authoritative read.
            for _ in 0..200 {
                if backend
                    .operation_state(repo)
                    .await?
                    .conflicted_paths
                    .is_empty()
                {
                    fjord_git::record_repository_changes(
                        repo,
                        fjord_fs::RepoChangeSet {
                            status: true,
                            working: true,
                            ..Default::default()
                        },
                    );
                    return Ok(json!({"fixtureRepositoryChanged": {
                        "repoId": args["repoId"], "status": true, "working": true, "history": false,
                        "refs": false, "stashes": false, "config": false, "statusSummary": null,
                        "generations": backend.generations(repo)?,
                    }}));
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            return Err("fixture merge tool did not finish".into());
        }
        other => return Err(format!("unexpected fixture command: {other}").into()),
    };
    Ok(json!({"data": data, "generations": backend.generations(repo)?}))
}
