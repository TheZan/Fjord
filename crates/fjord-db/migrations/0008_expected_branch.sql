-- P10-09: one optional literal branch name per workspace, matched against
-- each repository's current branch to derive `RepoCondition::WrongBranch`.
-- See docs/specs/workspace-workflows.md §5 and docs/specs/data-model.md.
--
-- NULL      -> the workspace has no expected-branch convention (the default,
--              and what every pre-0008 row keeps after this migration)
-- 'develop' -> literal local branch name; comparison is exact, never a glob,
--              a remote-tracking name, or a case-insensitive match.
ALTER TABLE workspaces ADD COLUMN expected_branch TEXT;
