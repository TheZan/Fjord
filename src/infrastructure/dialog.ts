import { open } from "@tauri-apps/plugin-dialog";

/** Native folder picker. Resolves to `null` if the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

/** Native single-file picker used for executable overrides. */
export async function pickFile(): Promise<string | null> {
  const selected = await open({ directory: false, multiple: false });
  return typeof selected === "string" ? selected : null;
}
