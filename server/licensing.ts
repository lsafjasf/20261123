import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  COURSE_ID,
  COURSE_SEGMENTS,
  COURSE_VERSION,
  LICENSE_POLICY,
  buildManifest,
  type CourseSegment,
} from "./course.js";

interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface IssuedLicense {
  segmentId: string;
  keyId: string;
  keyEpoch: number;
  key: string;
  keyFingerprint: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface LicenseAuthority {
  createSession(now?: number): {
    sessionId: string;
    serverTime: number;
    expiresAt: number;
    publicKey: JsonWebKey;
    policy: typeof LICENSE_POLICY;
  };
  issueLicenses(sessionId: string, segmentIds: string[], now?: number): IssuedLicense[];
  getManifest(now?: number): ReturnType<typeof buildManifest>;
  getPublicJwk(): JsonWebKey;
}

const HEADER = { alg: "ES256", typ: "NIMBUS-LICENSE" };

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function jsonPart(value: unknown): string {
  return base64url(Buffer.from(JSON.stringify(value), "utf8"));
}

function findSegment(segmentId: string): CourseSegment {
  const segment = COURSE_SEGMENTS.find((candidate) => candidate.id === segmentId);
  if (!segment) {
    throw new Error(`Unknown segment: ${segmentId}`);
  }
  return segment;
}

export function createLicenseAuthority(): LicenseAuthority {
  const masterSecret = randomBytes(32);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const sessions = new Map<string, SessionRecord>();

  function deriveSegmentKey(segment: CourseSegment): Buffer {
    return createHmac("sha256", masterSecret)
      .update(`${COURSE_ID}:${COURSE_VERSION}:${segment.keyId}:${segment.keyEpoch}`)
      .digest()
      .subarray(0, 16);
  }

  function signLicense(payload: Record<string, unknown>): string {
    const input = `${jsonPart(HEADER)}.${jsonPart(payload)}`;
    const signature = sign("sha256", Buffer.from(input, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${input}.${base64url(signature)}`;
  }

  function requireSession(sessionId: string, now: number): SessionRecord {
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= now) {
      sessions.delete(sessionId);
      throw new Error("SESSION_EXPIRED");
    }
    return session;
  }

  return {
    createSession(now = Date.now()) {
      const id = randomBytes(16).toString("hex");
      const record = {
        id,
        createdAt: now,
        expiresAt: now + LICENSE_POLICY.sessionTtlMs,
      };
      sessions.set(id, record);
      return {
        sessionId: id,
        serverTime: now,
        expiresAt: record.expiresAt,
        publicKey: publicJwk,
        policy: LICENSE_POLICY,
      };
    },

    issueLicenses(sessionId, segmentIds, now = Date.now()) {
      const session = requireSession(sessionId, now);
      const uniqueIds = [...new Set(segmentIds)];
      return uniqueIds.map((segmentId) => {
        const segment = findSegment(segmentId);
        const key = deriveSegmentKey(segment);
        const issuedAt = now;
        const expiresAt = now + LICENSE_POLICY.licenseTtlMs;
        const payload = {
          iss: "nimbus-local-authority",
          aud: "offline-training-player",
          sub: session.id,
          jti: randomBytes(12).toString("hex"),
          segmentId: segment.id,
          keyId: segment.keyId,
          keyEpoch: segment.keyEpoch,
          manifestId: `${COURSE_ID}@${COURSE_VERSION}`,
          iat: issuedAt,
          nbf: issuedAt - 5_000,
          exp: expiresAt,
          offline: "cached-verified-only",
          pause: "clock-keeps-running",
        };
        return {
          segmentId,
          keyId: segment.keyId,
          keyEpoch: segment.keyEpoch,
          key: base64url(key),
          keyFingerprint: base64url(createHash("sha256").update(key).digest()),
          token: signLicense(payload),
          issuedAt,
          expiresAt,
        };
      });
    },

    getManifest() {
      return buildManifest();
    },

    getPublicJwk() {
      return publicJwk;
    },
  };
}

export function verifyLicenseToken(token: string, publicKey: KeyObject): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`, "utf8"),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature ?? "", "base64url"),
  );
  if (!valid) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
