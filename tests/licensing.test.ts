import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import test from "node:test";
import { COURSE_SEGMENTS } from "../dist/server/course.js";
import { createLicenseAuthority, verifyLicenseToken } from "../dist/server/licensing.js";

test("manifest exposes four segments and a mid-play key rotation", () => {
  const authority = createLicenseAuthority();
  const manifest = authority.getManifest();
  assert.equal(manifest.segments.length, 4);
  assert.equal(new Set(manifest.segments.map((segment) => segment.keyEpoch)).size, 2);
  assert.equal(manifest.segments[0]?.keyEpoch, 1);
  assert.equal(manifest.segments[2]?.keyEpoch, 2);
  assert.equal(manifest.segments[2]?.rotation, "rotated");
  assert.equal(JSON.stringify(manifest).includes('"key"'), false);
});

test("licenses are signed, segment-bound and rotate key material by epoch", () => {
  const authority = createLicenseAuthority();
  const session = authority.createSession(1_000_000);
  const publicKey = createPublicKey({ key: session.publicKey, format: "jwk" });
  const licenses = authority.issueLicenses(
    session.sessionId,
    COURSE_SEGMENTS.map((segment) => segment.id),
    1_000_000,
  );
  assert.equal(licenses.length, 4);
  assert.equal(licenses[0]?.key, licenses[1]?.key);
  assert.notEqual(licenses[1]?.key, licenses[2]?.key);
  assert.equal(licenses[0]?.expiresAt, 1_030_000);

  for (const license of licenses) {
    const payload = verifyLicenseToken(license.token, publicKey);
    assert.ok(payload);
    assert.equal(payload.segmentId, license.segmentId);
    assert.equal(payload.keyId, license.keyId);
    assert.equal(payload.keyEpoch, license.keyEpoch);
    assert.equal(payload.exp, license.expiresAt);
    assert.equal(payload.pause, "clock-keeps-running");
  }
});

test("expired sessions cannot mint fresh licenses", () => {
  const authority = createLicenseAuthority();
  const session = authority.createSession(2_000_000);
  assert.throws(
    () => authority.issueLicenses(session.sessionId, ["seg-01"], session.expiresAt + 1),
    /SESSION_EXPIRED/,
  );
});

test("unknown segments and tampered signatures are rejected", () => {
  const authority = createLicenseAuthority();
  const session = authority.createSession(3_000_000);
  const publicKey = createPublicKey({ key: session.publicKey, format: "jwk" });
  assert.throws(() => authority.issueLicenses(session.sessionId, ["seg-99"], 3_000_000), /Unknown segment/);

  const [license] = authority.issueLicenses(session.sessionId, ["seg-01"], 3_000_000);
  assert.ok(license);
  const parts = license.token.split(".");
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -2)}AA`;
  assert.equal(verifyLicenseToken(tampered, publicKey), null);
});
