// Validates a Tauri v2 updater manifest (`latest.json`) against the
// platforms Fjord actually ships, generalized from a bug a partially
// successful release matrix can otherwise hide: `tauri-action` writes
// `latest.json` incrementally as each matrix leg finishes, so a release with
// three green legs and one red one can still produce a *complete-looking*
// `latest.json` file that is missing the failed platform's entry entirely —
// checking only "does latest.json exist" (as `packaging-verification` used
// to) does not catch that.

export const REQUIRED_UPDATER_PLATFORMS = ["windows-x86_64", "linux-x86_64", "darwin-aarch64", "darwin-x86_64"];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {object} params
 * @param {unknown} params.manifest parsed `latest.json`
 * @param {string} params.version expected `MAJOR.MINOR.PATCH`
 * @param {string} params.tag expected `vMAJOR.MINOR.PATCH`
 * @param {string[]} params.assetNames every asset name currently attached to the release
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyUpdaterManifest({ manifest, version, tag, assetNames }) {
  const problems = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, problems: ["latest.json is missing or is not a JSON object"] };
  }

  if (manifest.version !== version) {
    problems.push(`latest.json .version is ${JSON.stringify(manifest.version ?? null)}; expected ${JSON.stringify(version)}`);
  }

  const platforms =
    manifest.platforms && typeof manifest.platforms === "object" && !Array.isArray(manifest.platforms)
      ? manifest.platforms
      : {};

  for (const key of REQUIRED_UPDATER_PLATFORMS) {
    const entry = platforms[key];
    if (!entry || typeof entry !== "object") {
      problems.push(`latest.json is missing the required platform entry "${key}"`);
      continue;
    }

    if (!isNonEmptyString(entry.signature)) {
      problems.push(`latest.json platform "${key}" has no signature`);
    }

    if (!isNonEmptyString(entry.url)) {
      problems.push(`latest.json platform "${key}" has no url`);
      continue;
    }

    let url;
    try {
      url = new URL(entry.url);
    } catch {
      problems.push(`latest.json platform "${key}" url is not a valid URL: ${entry.url}`);
      continue;
    }

    if (!url.pathname.includes(`/releases/download/${tag}/`)) {
      problems.push(`latest.json platform "${key}" url does not point at this release's tag (${tag}): ${entry.url}`);
    }

    const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (!filename || !assetNames.includes(filename)) {
      problems.push(`latest.json platform "${key}" references "${filename || entry.url}", which is not an attached release asset`);
    }
  }

  return { ok: problems.length === 0, problems };
}
