import assert from "node:assert/strict";
import test from "node:test";

import { decideAppleSigningMode, REQUIRED_FOR_SIGNING } from "./apple-signing-lib.mjs";

const FULL_ENV = {
  APPLE_CERTIFICATE: "base64-cert",
  APPLE_CERTIFICATE_PASSWORD: "cert-password",
  APPLE_ID: "dev@example.com",
  APPLE_PASSWORD: "app-specific-password",
  APPLE_TEAM_ID: "ABCDE12345",
};

test("no Apple secrets configured -> unsigned, no missing vars reported", () => {
  const result = decideAppleSigningMode({});
  assert.equal(result.mode, "unsigned");
  assert.deepEqual(result.missing, []);
});

test("only unrelated env vars set -> still unsigned", () => {
  const result = decideAppleSigningMode({ PATH: "/usr/bin", CI: "true" });
  assert.equal(result.mode, "unsigned");
});

test("empty-string secrets (GitHub Actions' representation of an unset secret) count as absent", () => {
  const env = Object.fromEntries(Object.keys(FULL_ENV).map((key) => [key, ""]));
  const result = decideAppleSigningMode(env);
  assert.equal(result.mode, "unsigned");
});

test("whitespace-only secret counts as absent", () => {
  const result = decideAppleSigningMode({ ...FULL_ENV, APPLE_TEAM_ID: "   " });
  assert.equal(result.mode, "error");
});

test("complete required configuration -> signed", () => {
  const result = decideAppleSigningMode(FULL_ENV);
  assert.equal(result.mode, "signed");
  assert.deepEqual(result.missing, []);
});

test("complete configuration plus optional signing identity -> still signed", () => {
  const result = decideAppleSigningMode({ ...FULL_ENV, APPLE_SIGNING_IDENTITY: "Developer ID Application: Example" });
  assert.equal(result.mode, "signed");
});

test("partial configuration -> error naming every missing variable", () => {
  const { APPLE_TEAM_ID, ...partial } = FULL_ENV;
  void APPLE_TEAM_ID;
  const result = decideAppleSigningMode(partial);
  assert.equal(result.mode, "error");
  assert.deepEqual(result.missing, ["APPLE_TEAM_ID"]);
  assert.match(result.message, /APPLE_TEAM_ID/);
});

test("only the optional signing identity set -> error, not silently unsigned", () => {
  const result = decideAppleSigningMode({ APPLE_SIGNING_IDENTITY: "Developer ID Application: Example" });
  assert.equal(result.mode, "error");
  assert.deepEqual(result.missing, REQUIRED_FOR_SIGNING);
});

test("only certificate pair set, notarization credentials missing -> error", () => {
  const result = decideAppleSigningMode({
    APPLE_CERTIFICATE: FULL_ENV.APPLE_CERTIFICATE,
    APPLE_CERTIFICATE_PASSWORD: FULL_ENV.APPLE_CERTIFICATE_PASSWORD,
  });
  assert.equal(result.mode, "error");
  assert.deepEqual(result.missing, ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]);
});
