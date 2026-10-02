import crypto from "node:crypto";

/**
 * Verifies an HMAC-SHA256 signature over the raw request body, sent by
 * calling-engine as an `X-Signature` header. This is the one piece that has
 * to match calling-engine's webhooks.js exactly.
 *
 * Expected header format: "sha256=<hex digest>"
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
