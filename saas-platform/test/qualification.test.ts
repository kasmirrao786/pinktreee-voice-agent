import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreQualification } from "../src/lib/intelligence/qualification";
import type { CallIntelligence } from "../src/lib/intelligence/callIntelligence";

function baseIntelligence(overrides: Partial<CallIntelligence> = {}): CallIntelligence {
  return {
    summary: "test",
    outcome: "unclear",
    sentiment: "neutral",
    intent: null,
    objections: [],
    questions: [],
    follow_up_required: false,
    appointment_requested: false,
    extracted_info: { budget: null, requirements: null, timeline: null },
    ...overrides,
  };
}

test("booked_demo outcome scores hot", () => {
  const result = scoreQualification(baseIntelligence({ outcome: "booked_demo" }));
  assert.equal(result.label, "hot");
  assert.ok(result.score >= 85, `expected high score, got ${result.score}`);
});

test("not_interested outcome scores very low regardless of sentiment", () => {
  const result = scoreQualification(baseIntelligence({ outcome: "not_interested", sentiment: "positive" }));
  assert.equal(result.label, "not_interested");
  assert.ok(result.score <= 15, `expected low score, got ${result.score}`);
});

test("appointment_requested forces hot even on an otherwise cold outcome", () => {
  const result = scoreQualification(baseIntelligence({ outcome: "unclear", appointment_requested: true }));
  assert.equal(result.label, "hot");
  assert.ok(result.score >= 85);
});

test("negative sentiment reduces score but does not go below zero", () => {
  const result = scoreQualification(baseIntelligence({ outcome: "not_interested", sentiment: "negative" }));
  assert.ok(result.score >= 0);
});

test("specificity bonus: budget + timeline + requirements nudge score up", () => {
  const withoutInfo = scoreQualification(baseIntelligence({ outcome: "interested_followup" }));
  const withInfo = scoreQualification(
    baseIntelligence({
      outcome: "interested_followup",
      extracted_info: { budget: "$5k/mo", requirements: "10 seats", timeline: "next quarter" },
    })
  );
  assert.ok(withInfo.score > withoutInfo.score, `expected ${withInfo.score} > ${withoutInfo.score}`);
});

test("score is always clamped between 0 and 100", () => {
  const result = scoreQualification(
    baseIntelligence({
      outcome: "booked_demo",
      sentiment: "positive",
      appointment_requested: true,
      extracted_info: { budget: "x", requirements: "y", timeline: "z" },
    })
  );
  assert.ok(result.score <= 100);
});
