import type { LicenseGrant, LicensePayload, WrappedKey } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = toBytes(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256Base64Url(value: ArrayBuffer | Uint8Array): Promise<string> {
  const copy = new Uint8Array(toBytes(value));
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return encodeBase64Url(digest);
}

export function createWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

export async function importContentKey(rawKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decodeBase64Url(rawKey), { name: "AES-GCM", length: 128 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapContentKey(contentKey: CryptoKey, wrappingKey: CryptoKey): Promise<WrappedKey> {
  const wrapped = await crypto.subtle.wrapKey("raw", contentKey, wrappingKey, "AES-KW");
  return { iv: "", data: encodeBase64Url(wrapped) };
}

export function unwrapContentKey(wrapped: WrappedKey, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    decodeBase64Url(wrapped.data),
    wrappingKey,
    "AES-KW",
    { name: "AES-GCM", length: 128 },
    false,
    ["decrypt"],
  );
}

export async function encryptSegment(
  plaintext: ArrayBuffer,
  contentKey: CryptoKey,
): Promise<{ ciphertext: ArrayBuffer; iv: string; plaintextSize: number }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, contentKey, plaintext);
  return {
    ciphertext,
    iv: encodeBase64Url(iv),
    plaintextSize: plaintext.byteLength,
  };
}

export function decryptSegment(ciphertext: ArrayBuffer, iv: string, contentKey: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64Url(iv) },
    contentKey,
    ciphertext,
  );
}

export async function rawKeyFingerprint(rawKey: string): Promise<string> {
  return sha256Base64Url(decodeBase64Url(rawKey));
}

export async function verifyLicenseToken(
  token: string,
  publicKey: JsonWebKey,
): Promise<{ payload: LicensePayload; header: Record<string, unknown> }> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("许可证格式无效");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(decoder.decode(decodeBase64Url(encodedHeader ?? ""))) as Record<string, unknown>;
  if (header.alg !== "ES256" || header.typ !== "NIMBUS-LICENSE") {
    throw new Error("许可证算法不受信任");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64Url(encodedSignature ?? ""),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) {
    throw new Error("许可证签名校验失败");
  }
  const payload = JSON.parse(decoder.decode(decodeBase64Url(encodedPayload ?? ""))) as LicensePayload;
  return { payload, header };
}

export async function attestGrant(grant: LicenseGrant, publicKey: JsonWebKey): Promise<LicensePayload> {
  const { payload } = await verifyLicenseToken(grant.token, publicKey);
  if (payload.segmentId !== grant.segmentId || payload.keyId !== grant.keyId || payload.keyEpoch !== grant.keyEpoch) {
    throw new Error("许可证与片段声明不一致");
  }
  if (payload.exp !== grant.expiresAt) {
    throw new Error("许可证到期时间不一致");
  }
  const fingerprint = await rawKeyFingerprint(grant.key);
  if (fingerprint !== grant.keyFingerprint) {
    throw new Error("密钥指纹不一致");
  }
  return payload;
}
