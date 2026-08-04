// Mirrors `fjord_domain::Settings` / `Theme` (crates/fjord-domain/src/lib.rs).
//
// Hand-written for now. Per docs/SDD.md §6.1 this should become a generated
// type (specta/ts-rs) once that toolchain is wired up — tracked as a
// follow-up, not done in the Phase 0 pass that first got the app booting.

export type Theme = "light" | "dark" | "system";

export interface Settings {
  locale: string;
  theme: Theme;
  defaultIde: string | null;
}
