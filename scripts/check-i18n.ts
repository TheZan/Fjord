// Locale catalog drift check — see docs/specs/i18n.md §CI check (P4-16).
//
// Loads every `src/locales/<code>/*.json`, diffs its key set against the
// matching `src/locales/en/*.json`, and exits non-zero on any missing or
// orphaned key, per namespace, per locale. Plural suffixes are normalized
// (`_one`/`_few`/`_many`/... collapse to the base key) so locales with
// different plural-form counts don't false-positive.
//
// Run with `npm run check-i18n` (plain `node` — no build step needed).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const REFERENCE_LOCALE = "en";
const PLURAL_SUFFIXES = new Set(["zero", "one", "two", "few", "many", "other"]);

type Catalog = { [key: string]: string | Catalog };

function listLocales(): string[] {
  return readdirSync(LOCALES_DIR).filter((entry) =>
    statSync(join(LOCALES_DIR, entry)).isDirectory(),
  );
}

function listNamespaces(locale: string): string[] {
  return readdirSync(join(LOCALES_DIR, locale))
    .filter((file) => file.endsWith(".json"))
    .sort();
}

/** `{ a: { b: "x" } }` → `["a.b"]`, with i18next plural suffixes stripped. */
function flattenKeys(catalog: Catalog, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      keys.add(stripPluralSuffix(path));
    } else {
      for (const nested of flattenKeys(value, path)) keys.add(nested);
    }
  }
  return keys;
}

function stripPluralSuffix(key: string): string {
  const underscore = key.lastIndexOf("_");
  if (underscore === -1) return key;
  const suffix = key.slice(underscore + 1);
  return PLURAL_SUFFIXES.has(suffix) ? key.slice(0, underscore) : key;
}

function readCatalog(locale: string, namespace: string): Set<string> {
  const raw = readFileSync(join(LOCALES_DIR, locale, namespace), "utf-8");
  return flattenKeys(JSON.parse(raw) as Catalog);
}

function diff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((key) => !b.has(key)).sort();
}

let problems = 0;

function report(locale: string, namespace: string, kind: string, keys: string[]) {
  for (const key of keys) {
    problems += 1;
    console.error(`  ${locale}/${namespace}: ${kind} key '${key}'`);
  }
}

const referenceNamespaces = listNamespaces(REFERENCE_LOCALE);
const locales = listLocales().filter((locale) => locale !== REFERENCE_LOCALE);

for (const locale of locales) {
  const namespaces = listNamespaces(locale);

  for (const namespace of diff(new Set(referenceNamespaces), new Set(namespaces))) {
    problems += 1;
    console.error(`  ${locale}: missing namespace file '${namespace}'`);
  }
  for (const namespace of diff(new Set(namespaces), new Set(referenceNamespaces))) {
    problems += 1;
    console.error(`  ${locale}: orphaned namespace file '${namespace}' (no ${REFERENCE_LOCALE} counterpart)`);
  }

  for (const namespace of namespaces.filter((ns) => referenceNamespaces.includes(ns))) {
    const reference = readCatalog(REFERENCE_LOCALE, namespace);
    const translated = readCatalog(locale, namespace);
    report(locale, namespace, "missing", diff(reference, translated));
    report(locale, namespace, "orphaned", diff(translated, reference));
  }
}

if (problems > 0) {
  console.error(`\ncheck-i18n: ${problems} problem(s) found.`);
  process.exit(1);
}

console.log(
  `check-i18n: OK — ${locales.length} locale(s) in sync with '${REFERENCE_LOCALE}' across ${referenceNamespaces.length} namespace(s).`,
);
