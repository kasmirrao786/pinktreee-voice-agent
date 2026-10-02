import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCallIntelligence } from "../src/lib/intelligence/callIntelligence";

test("empty transcript returns a safe default without calling the LLM", async () => {
  const result = await extractCallIntelligence("");
  assert.equal(result.outcome, "unclear");
  assert.equal(result.sentiment, "neutral");
  assert.deepEqual(result.objections, []);
  assert.deepEqual(result.extracted_info, { budget: null, requirements: null, timeline: null });
});

test("whitespace-only transcript is treated as empty", async () => {
  const result = await extractCallIntelligence("   \n  ");
  assert.equal(result.outcome, "unclear");
});

test("null transcript is treated as empty", async () => {
  const result = await extractCallIntelligence(null);
  assert.equal(result.outcome, "unclear");
});
