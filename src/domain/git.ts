// Mirrors `fjord_domain::BranchInfo` (crates/fjord-domain/src/lib.rs).
// See the note in domain/settings.ts about generating these later.

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
}
