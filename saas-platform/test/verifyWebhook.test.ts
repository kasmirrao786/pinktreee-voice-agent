import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyWebhookSignature } from "../src/lib/intelligence/verifyWebhook";

const SECRET = "test-secret";

function sign(body: string, secret = SECRET) {
  const digest = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

test("valid signature passes", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test("tampered body fails verification", () => {
  const body = JSON.stringify({ hello: "world" });
  const sig = sign(body);
  const tamperedBody = JSON.stringify({ hello: "WORLD" });
  assert.equal(verifyWebhookSignature(tamperedBody, sig, SECRET), false);
});

test("wrong secret fails verification", () => {
  const body = JSON.stringify({ hello: "world" });
  const sig = sign(body, "wrong-secret");
  assert.equal(verifyWebhookSignature(body, sig, SECRET), false);
});

test("missing header fails verification", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyWebhookSignature(body, null, SECRET), false);
});

test("malformed header (no sha256= prefix) fails verification", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyWebhookSignature(body, "not-a-real-signature", SECRET), false);
});
