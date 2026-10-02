// Ported from the standalone intelligence-service (src/llm.js) when that
// service was folded into this project — see root README's "Restructuring"
// section for why. Logic unchanged, just typed.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Calls the LLM and expects a single JSON object back. Retries once with a
 * stricter "reply with ONLY JSON" reminder if the first response fails to
 * parse — cheap insurance against an occasional chatty response.
 */
export async function callLLMForJSON<T = unknown>(systemPrompt: string, userPrompt: string): Promise<T> {
  const raw = await callLLM(systemPrompt, userPrompt);
  const parsed = tryParseJSON<T>(raw);
  if (parsed) return parsed;

  const retryRaw = await callLLM(
    systemPrompt,
    userPrompt +
      "\n\nIMPORTANT: Reply with ONLY a single valid JSON object. No markdown, no code fences, no commentary."
  );
  const retryParsed = tryParseJSON<T>(retryRaw);
  if (retryParsed) return retryParsed;

  throw new Error(`LLM did not return valid JSON after retry. Last response: ${retryRaw?.slice(0, 500)}`);
}

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function tryParseJSON<T>(text: string): T | null {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
