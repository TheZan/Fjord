// IPC contract drift check — see docs/specs/ipc-commands.md (P5-23).
//
// The command surface has three representations that must agree:
//
//   1. `tauri::generate_handler![...]` in crates/fjord-app/src/lib.rs — what
//      the backend actually exposes;
//   2. `invoke("...")` calls in src/infrastructure/tauriClient.ts — what the
//      frontend can actually call;
//   3. the tables in docs/specs/ipc-commands.md — what a reader is told.
//
// The audit that produced this script found the spec documenting roughly half
// the shipped surface, because nothing ever compared them. Reconciling by hand
// only works until the next command lands.
//
// Run with `npm run check-ipc-docs` (plain `node` — no build step needed).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HANDLER_PATH = join(ROOT, "crates", "fjord-app", "src", "lib.rs");
const CLIENT_PATH = join(ROOT, "src", "infrastructure", "tauriClient.ts");
const SPEC_PATH = join(ROOT, "docs", "specs", "ipc-commands.md");
const EVENTS_SPEC_PATH = join(ROOT, "docs", "specs", "operation-events.md");

/** Heading after which the spec describes commands that do not exist yet. */
const PLANNED_HEADING = "## Planned additions";

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

/** Command names registered with Tauri, in registration order. */
function registeredCommands(): Set<string> {
  const source = read(HANDLER_PATH);
  const start = source.indexOf("tauri::generate_handler![");
  if (start === -1) throw new Error(`no generate_handler! block in ${HANDLER_PATH}`);
  const end = source.indexOf("]", start);
  const block = source.slice(start, end);
  return new Set([...block.matchAll(/commands::(\w+)/g)].map((match) => match[1]));
}

/**
 * Command names the typed frontend client can invoke. Three call shapes carry
 * the name in different positions:
 *
 *   invoke("cancel_operation", …)                      — first argument
 *   invokeAbortable("get_branches", …)                 — first argument
 *   invokeOperation("publish", "publish_branch", …)    — second, after the kind
 */
function invokedCommands(): Set<string> {
  const source = read(CLIENT_PATH);
  const names = new Set<string>();
  const patterns = [
    /\binvoke(?:<[^>]*>)?\(\s*"(\w+)"/g,
    /\binvokeAbortable(?:<[^>]*>)?\(\s*"(\w+)"/g,
    /\binvokeOperation(?:<[^>]*>)?\(\s*"[^"]*"\s*,\s*"(\w+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

/**
 * Command names documented as shipped. Reads the backticked identifiers in the
 * first column of every table before the "Planned additions" heading, so one
 * row may legitimately document several related commands.
 */
function documentedCommands(path: string): Set<string> {
  const source = read(path);
  const shipped = source.split(PLANNED_HEADING)[0];
  const names = new Set<string>();
  for (const line of shipped.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstColumn = line.split("|")[1] ?? "";
    for (const match of firstColumn.matchAll(/`(\w+)`/g)) names.add(match[1]);
  }
  return names;
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((name) => !b.has(name)).sort();
}

const registered = registeredCommands();
const invoked = invokedCommands();
const documented = documentedCommands(SPEC_PATH);
const documentedEvents = documentedCommands(EVENTS_SPEC_PATH);

let problems = 0;

function report(kind: string, names: string[]) {
  for (const name of names) {
    problems += 1;
    console.error(`  ${kind}: ${name}`);
  }
}

report(
  "registered but not documented in ipc-commands.md",
  diff(registered, documented),
);
report(
  "documented as shipped in ipc-commands.md but not registered",
  diff(documented, registered),
);
report(
  "documented in operation-events.md but not registered",
  diff(documentedEvents, registered),
);
// A command with no wrapper is unreachable from the app. That is occasionally
// deliberate, but it should be a decision someone made, not a leftover.
report("registered but unreachable from tauriClient.ts", diff(registered, invoked));
report("invoked by tauriClient.ts but not registered", diff(invoked, registered));

if (problems > 0) {
  console.error(
    `\ncheck-ipc-docs: ${problems} problem(s) found. Update docs/specs/ipc-commands.md, ` +
      `the handler registration, or the typed client so all three agree.`,
  );
  process.exit(1);
}

console.log(
  `check-ipc-docs: OK — ${registered.size} command(s) registered, documented, and reachable.`,
);
