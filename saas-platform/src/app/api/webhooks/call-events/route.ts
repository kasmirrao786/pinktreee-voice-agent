import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/intelligence/verifyWebhook";
import { handleCallEvent, type CallEndedEvent } from "@/lib/intelligence/eventHandler";

/**
 * Receives call.* events from calling-engine. See
 * src/lib/intelligence/verifyWebhook.ts for the signature scheme —
 * calling-engine's webhooks.js must sign with the same
 * CALL_EVENTS_WEBHOOK_SECRET.
 *
 * Replaces the standalone intelligence-service's Express route of the same
 * path/shape — calling-engine's webhooks.js only needed its base URL
 * updated to point here (CALLING_ENGINE_URL's sibling env var,
 * INTELLIGENCE_SERVICE_URL, now just points at this same saas-platform
 * deployment instead of a separate service).
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const secret = process.env.CALL_EVENTS_WEBHOOK_SECRET;
  if (secret) {
    const signature = request.headers.get("X-Signature");
    const valid = verifyWebhookSignature(rawBody, signature, secret);
    if (!valid) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  } else {
    console.warn(
      "CALL_EVENTS_WEBHOOK_SECRET is not set - webhook signature is NOT being verified. Do not run like this in production."
    );
  }

  let event: CallEndedEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await handleCallEvent(event);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    console.error("Failed to process call event:", err);
    // 500 so calling-engine's own retry logic (if it has any - currently
    // it doesn't, see root README) would kick in, rather than silently
    // dropping a call this failed to process.
    return NextResponse.json({ error: "processing failed", detail: (err as Error).message }, { status: 500 });
  }
}
