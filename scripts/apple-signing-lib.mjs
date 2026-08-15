// Decides whether a macOS release build should sign (and notarize), build
// unsigned, or refuse to proceed — from GitHub Actions secret presence, not
// their values, so this stays testable without ever touching real
// certificates. The one rule that matters: an unsigned decision must never
// be reached by silently ignoring a half-configured signing setup — that's
// exactly what produced the SecKeychainItemImport failure release #2 hit
// (empty-string APPLE_CERTIFICATE still reaches Tauri's signing path).
//
// `APPLE_SIGNING_IDENTITY` is intentionally not "required" — Tauri infers it
// from the certificate when omitted — but it still counts as "an attempt was
// made", so setting only that one still fails closed rather than silently
// building unsigned.

export const REQUIRED_FOR_SIGNING = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
];

export const OPTIONAL_FOR_SIGNING = ["APPLE_SIGNING_IDENTITY"];

export const ALL_APPLE_SIGNING_VARS = [...REQUIRED_FOR_SIGNING, ...OPTIONAL_FOR_SIGNING];

function isSet(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: "unsigned" | "signed" | "error", missing: string[], message: string }}
 */
export function decideAppleSigningMode(env) {
  const present = ALL_APPLE_SIGNING_VARS.filter((name) => isSet(env[name]));

  if (present.length === 0) {
    return {
      mode: "unsigned",
      missing: [],
      message: "Apple signing credentials are not configured — building unsigned macOS packages.",
    };
  }

  const missing = REQUIRED_FOR_SIGNING.filter((name) => !isSet(env[name]));
  if (missing.length === 0) {
    return {
      mode: "signed",
      missing: [],
      message: "Apple signing credentials are fully configured — building signed macOS packages.",
    };
  }

  return {
    mode: "error",
    missing,
    message:
      `Apple signing is partially configured: missing ${missing.join(", ")}. ` +
      `Set all of ${REQUIRED_FOR_SIGNING.join(", ")} to sign and notarize, ` +
      "or clear all Apple signing secrets to build unsigned.",
  };
}
