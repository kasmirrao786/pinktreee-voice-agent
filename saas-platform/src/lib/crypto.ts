import crypto from "crypto";

/**
 * Credential encryption for `provider_credentials.encrypted_value`.
 *
 * Scheme (fixed by the Project 2 build spec — do not swap algorithms):
 *   - AES-256-GCM at the application layer, before the value touches the DB.
 *   - A random 96-bit (12-byte) nonce is generated per value.
 *   - `nonce + ciphertext + authTag` are packed together and base64-encoded
 *     into a single string stored in `encrypted_value`.
 *   - The master key comes from CREDENTIAL_ENCRYPTION_KEY (base64, 32 bytes),
 *     an env secret injected at deploy time. It is never logged, committed,
 *     or returned to the frontend.
 *   - `encryption_key_version` is stored alongside so the master key can be
 *     rotated later without a data migration: bump CREDENTIAL_ENCRYPTION_KEY
 *     (and CREDENTIAL_ENCRYPTION_KEY_VERSION) for new writes; old rows stay
 *     decryptable as long as the old key is kept available for that version.
 *
 * If the hosting environment has a managed KMS available cheaply (AWS KMS /
 * GCP KMS) at deploy time, wrap the master key with it instead of storing a
 * bare env var — swap `getMasterKey()` below for a KMS-unwrap call. The
 * AES-256-GCM-on-the-value part stays the same either way.
 */

const NONCE_LENGTH = 12; // 96-bit nonce, standard for GCM
const AUTH_TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const b64 = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it as an env secret."
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  }
  return key;
}

export function getCurrentKeyVersion(): number {
  return parseInt(process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION || "1", 10);
}

/** Encrypts a plaintext credential value. Returns the packed base64 string to store. */
export function encryptCredential(plaintext: string): { encryptedValue: string; keyVersion: number } {
  const key = getMasterKey();
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const packed = Buffer.concat([nonce, ciphertext, authTag]);
  return { encryptedValue: packed.toString("base64"), keyVersion: getCurrentKeyVersion() };
}

/** Decrypts a packed base64 string back into the plaintext credential value. */
export function decryptCredential(encryptedValue: string): string {
  const key = getMasterKey();
  const packed = Buffer.from(encryptedValue, "base64");

  const nonce = packed.subarray(0, NONCE_LENGTH);
  const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(NONCE_LENGTH, packed.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Masks a credential for display, e.g. "sk_live_abcd1234" -> "•••• 1234". Never send raw values to the client. */
export function maskCredential(plaintext: string): string {
  const last4 = plaintext.slice(-4);
  return `•••• ${last4}`;
}
