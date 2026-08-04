// Mirrors `fjord_domain::Workspace` / `RepositoryEntry`
// (crates/fjord-domain/src/lib.rs). Hand-written for now — see the note in
// domain/settings.ts about generating these once specta/ts-rs is wired up.

export interface Workspace {
  id: string;
  name: string;
  sortOrder: number;
}

export interface RepositoryEntry {
  id: string;
  workspaceId: string;
  name: string;
  path: string;
  sortOrder: number;
}
