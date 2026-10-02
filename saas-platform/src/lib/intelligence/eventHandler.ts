import { prisma } from "@/lib/db";
import { extractCallIntelligence, type CallIntelligence } from "./callIntelligence";
import { scoreQualification, type Qualification } from "./qualification";
import { getAvailableSlots, bookAppointment } from "./calendar/appointmentService";

export interface CallEndedEvent {
  event_id: string;
  event_type: string;
  tenant_id: string;
  call_id: string;
  lead_id: string | null;
  campaign_id: string | null;
  agent_id: string | null;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface HandleCallEventResult {
  skipped: boolean;
  reason?: string;
  intelligence?: CallIntelligence;
  qualification?: Qualification;
  appointment?: unknown;
}

/**
 * Entry point for every call-event calling-engine sends. Only `call.ended`
 * (or `call.transcript_ready`) triggers the intelligence pipeline —
 * everything else is acknowledged and ignored, so this doesn't break if
 * calling-engine adds new event types later.
 *
 * `extractFn` is injectable for tests (defaults to the real LLM-backed
 * extractor in production) — same pattern the standalone
 * intelligence-service used, kept because it's what let that service's own
 * integration test run without needing network access to an LLM.
 */
export async function handleCallEvent(
  event: CallEndedEvent,
  deps: { extractFn?: typeof extractCallIntelligence } = {}
): Promise<HandleCallEventResult> {
  const extractFn = deps.extractFn ?? extractCallIntelligence;

  if (!event.event_id) {
    throw new Error("call event is missing event_id - required for idempotency");
  }

  const alreadyProcessed = await prisma.processedCallEvent.findUnique({ where: { eventId: event.event_id } });
  if (alreadyProcessed) {
    console.log(`[eventHandler] event ${event.event_id} already processed, skipping`);
    return { skipped: true };
  }

  if (event.event_type !== "call.ended" && event.event_type !== "call.transcript_ready") {
    await prisma.processedCallEvent.upsert({
      where: { eventId: event.event_id },
      create: { eventId: event.event_id, callId: event.call_id },
      update: {},
    });
    return { skipped: true, reason: `event_type ${event.event_type} is not handled here` };
  }

  const callRow = await prisma.call.findUnique({
    where: { id: event.call_id },
    select: { id: true, tenantId: true, leadId: true, agentId: true, transcript: true },
  });
  if (!callRow) {
    throw new Error(`call ${event.call_id} not found - calling-engine should write the call row before emitting call.ended`);
  }

  const intelligence = await extractFn(callRow.transcript);
  const qualification = scoreQualification(intelligence);

  // extractedInfo is a JSON column, so this can carry everything the
  // pipeline extracted - not just budget/requirements/timeline - without
  // any schema change. Dropping objections/questions/follow-up here would
  // silently throw away data the build spec explicitly asks for.
  const fullExtractedInfo = {
    ...intelligence.extracted_info,
    objections: intelligence.objections,
    questions: intelligence.questions,
    follow_up_required: intelligence.follow_up_required,
    appointment_requested: intelligence.appointment_requested,
  };

  await prisma.$transaction([
    prisma.call.update({
      where: { id: event.call_id },
      data: {
        summary: intelligence.summary,
        outcome: intelligence.outcome,
        sentiment: intelligence.sentiment,
        extractedInfo: fullExtractedInfo,
      },
    }),
    ...(callRow.leadId
      ? [
          prisma.lead.update({
            where: { id: callRow.leadId },
            data: { qualification: qualification as unknown as object },
          }),
        ]
      : []),
    prisma.processedCallEvent.create({ data: { eventId: event.event_id, callId: event.call_id } }),
  ]);

  let appointment = null;
  if (intelligence.appointment_requested && callRow.leadId) {
    appointment = await tryBookAppointment(event, callRow);
  }

  return { skipped: false, intelligence, qualification, appointment };
}

/**
 * Books the first available slot automatically. This is the "post-call
 * confirmation" flow (the simpler v1 - live in-call slot offering would be
 * calling-engine calling getAvailableSlots directly mid-conversation
 * instead, not currently wired up).
 */
async function tryBookAppointment(
  event: CallEndedEvent,
  callRow: { id: string; tenantId: string; leadId: string | null; agentId: string }
) {
  try {
    const slots = await getAvailableSlots(event.tenant_id, { daysAhead: 7 });
    if (slots.length === 0) {
      console.warn(`[eventHandler] no available slots for tenant ${event.tenant_id}, skipping auto-booking`);
      return null;
    }

    const lead = callRow.leadId ? await prisma.lead.findUnique({ where: { id: callRow.leadId }, select: { name: true, email: true } }) : null;

    return await bookAppointment({
      tenantId: event.tenant_id,
      leadId: callRow.leadId as string,
      callId: callRow.id,
      agentId: callRow.agentId,
      slot: slots[0],
      leadName: lead?.name,
      leadEmail: lead?.email,
      notes: "Auto-booked from call intelligence pipeline",
    });
  } catch (err) {
    // Booking failure should never fail the whole event-processing
    // transaction - the call intelligence data is already saved by this
    // point. Log and move on; a human can follow up manually.
    console.error(`[eventHandler] appointment booking failed for call ${callRow.id}:`, err);
    return null;
  }
}
