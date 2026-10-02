import type { CallIntelligence, Outcome } from "./callIntelligence";

// Ported from intelligence-service's src/pipeline/qualification.js —
// deterministic rules over the LLM-extracted signals, not a second LLM
// call, so the score stays inspectable/debuggable and doesn't add extra
// latency/cost.

export const LABELS = ["hot", "warm", "cold", "interested", "not_interested", "follow_up"] as const;
export type QualificationLabel = (typeof LABELS)[number];

export interface Qualification {
  score: number;
  label: QualificationLabel;
  budget: string | null;
  requirements: string | null;
  timeline: string | null;
  intent: string | null;
}

const OUTCOME_BASE_SCORE: Record<Outcome, number> = {
  booked_demo: 90,
  interested_followup: 65,
  unclear: 35,
  wrong_person: 10,
  not_interested: 5,
  do_not_call: 0,
};

const OUTCOME_LABEL: Record<Outcome, QualificationLabel> = {
  booked_demo: "hot",
  interested_followup: "warm",
  unclear: "cold",
  wrong_person: "not_interested",
  not_interested: "not_interested",
  do_not_call: "not_interested",
};

export function scoreQualification(intelligence: CallIntelligence): Qualification {
  let score = OUTCOME_BASE_SCORE[intelligence.outcome] ?? 30;
  let label: QualificationLabel = OUTCOME_LABEL[intelligence.outcome] ?? "cold";

  const hasBudget = Boolean(intelligence.extracted_info.budget);
  const hasTimeline = Boolean(intelligence.extracted_info.timeline);
  const hasRequirements = Boolean(intelligence.extracted_info.requirements);
  const specificityBonus = [hasBudget, hasTimeline, hasRequirements].filter(Boolean).length * 5;
  score = Math.min(100, score + specificityBonus);

  if (intelligence.sentiment === "negative") score = Math.max(0, score - 15);
  if (intelligence.sentiment === "positive") score = Math.min(100, score + 5);

  // Appointment requested is the strongest positive signal available -
  // treat it as hot regardless of what the outcome classifier landed on,
  // since a booked/requested meeting is ground truth.
  if (intelligence.appointment_requested) {
    score = Math.max(score, 85);
    label = "hot";
  }

  return {
    score: Math.round(score),
    label: LABELS.includes(label) ? label : "cold",
    budget: intelligence.extracted_info.budget,
    requirements: intelligence.extracted_info.requirements,
    timeline: intelligence.extracted_info.timeline,
    intent: intelligence.intent,
  };
}
