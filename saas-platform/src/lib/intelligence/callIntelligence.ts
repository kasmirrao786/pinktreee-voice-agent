import { callLLMForJSON } from "./llm";

// Ported from intelligence-service's src/pipeline/callIntelligence.js — the
// generalized version of the original single-tenant repo's outcome
// classifier. One structured LLM call, not several — see the root README's
// "outcome vocabulary drift" note for why calling-engine no longer runs its
// own separate classifier.
export const OUTCOME_VALUES = [
  "booked_demo",
  "interested_followup",
  "not_interested",
  "wrong_person",
  "do_not_call",
  "unclear",
] as const;
export type Outcome = (typeof OUTCOME_VALUES)[number];

export const SENTIMENT_VALUES = ["positive", "neutral", "negative", "mixed"] as const;
export type Sentiment = (typeof SENTIMENT_VALUES)[number];

export interface CallIntelligence {
  summary: string;
  outcome: Outcome;
  sentiment: Sentiment;
  intent: string | null;
  objections: string[];
  questions: string[];
  follow_up_required: boolean;
  appointment_requested: boolean;
  extracted_info: {
    budget: string | null;
    requirements: string | null;
    timeline: string | null;
  };
}

const SYSTEM_PROMPT = `You are analyzing a finished sales/support phone call transcript between an AI voice agent and a lead.

Extract structured information and reply with ONLY a single JSON object matching this exact shape - no extra keys, no commentary, no markdown:

{
  "summary": "2-4 sentence plain-language summary of what happened on the call",
  "outcome": one of ${JSON.stringify(OUTCOME_VALUES)},
  "sentiment": one of ${JSON.stringify(SENTIMENT_VALUES)},
  "intent": "short phrase describing what the customer actually wants, or null if unclear",
  "objections": ["short phrase per objection raised, empty array if none"],
  "questions": ["short phrase per question the customer asked, empty array if none"],
  "follow_up_required": true or false,
  "appointment_requested": true or false,
  "extracted_info": {
    "budget": "value mentioned, or null",
    "requirements": "value mentioned, or null",
    "timeline": "value mentioned, or null"
  }
}

Base every field only on what is actually in the transcript. Use null or an empty array rather than guessing when something was not discussed.`;

export async function extractCallIntelligence(transcript: string | null): Promise<CallIntelligence> {
  if (!transcript || !transcript.trim()) {
    // No transcript (e.g. a missed/unanswered call) - return a safe default
    // instead of spending an LLM call on nothing.
    return normalize({ outcome: "unclear", sentiment: "neutral", objections: [], questions: [] });
  }

  const userPrompt = `Transcript:\n---\n${transcript}\n---`;
  const result = await callLLMForJSON<Record<string, unknown>>(SYSTEM_PROMPT, userPrompt);
  return normalize(result);
}

function normalize(result: Record<string, unknown>): CallIntelligence {
  const outcome = OUTCOME_VALUES.includes(result.outcome as Outcome) ? (result.outcome as Outcome) : "unclear";
  const sentiment = SENTIMENT_VALUES.includes(result.sentiment as Sentiment)
    ? (result.sentiment as Sentiment)
    : "neutral";
  const extractedInfo = (result.extracted_info as Record<string, unknown>) ?? {};

  return {
    summary: typeof result.summary === "string" ? result.summary : "",
    outcome,
    sentiment,
    intent: (result.intent as string | null) ?? null,
    objections: Array.isArray(result.objections) ? (result.objections as string[]) : [],
    questions: Array.isArray(result.questions) ? (result.questions as string[]) : [],
    follow_up_required: Boolean(result.follow_up_required),
    appointment_requested: Boolean(result.appointment_requested),
    extracted_info: {
      budget: (extractedInfo.budget as string | null) ?? null,
      requirements: (extractedInfo.requirements as string | null) ?? null,
      timeline: (extractedInfo.timeline as string | null) ?? null,
    },
  };
}
