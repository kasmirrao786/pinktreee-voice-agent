// Integration test: exercises handleCallEvent end to end against a real
// Postgres database via Prisma (schema must already be pushed - run
// `npm run db:push` first). Skips automatically if DATABASE_URL is not
// set, so `npm test` still passes in an unconfigured checkout.
//
// NOTE ON THIS SANDBOX SPECIFICALLY: this file could not be executed while
// porting it from the standalone intelligence-service, because Prisma's
// client has to be generated (`prisma generate`, which downloads an engine
// binary from binaries.prisma.sh) before `@prisma/client`'s TypeScript
// types even exist, and that download is blocked from this sandbox - the
// exact same limitation documented in the root README since the first
// integration pass. The equivalent test in the standalone service (raw SQL,
// no Prisma dependency) WAS run successfully there before the merge - see
// intelligence-service's old test suite in git history / the prior
// platform-combined.zip if you want to compare. This version should run
// fine anywhere with normal network access to generate the Prisma client
// first.
//
// The LLM call itself is stubbed via dependency injection (extractFn) so
// this needs no OPENROUTER_API_KEY or network access to an LLM - it proves
// the DB writes, idempotency, and appointment-booking wiring, not the LLM
// prompt itself (covered separately by callIntelligence.test.ts for the
// parts that don't need the network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const skip = !process.env.DATABASE_URL;

test("handleCallEvent writes intelligence + qualification and is idempotent", { skip }, async () => {
  const { prisma } = await import("../src/lib/db");
  const { handleCallEvent } = await import("../src/lib/intelligence/eventHandler");
  const { cancelAppointment } = await import("../src/lib/intelligence/calendar/appointmentService");

  const tenantId = randomUUID();
  const agentId = randomUUID();
  const leadId = randomUUID();
  const callId = randomUUID();
  const eventId = randomUUID();

  await prisma.tenant.create({ data: { id: tenantId, name: "Test Tenant" } });
  await prisma.agent.create({
    data: { id: agentId, tenantId, name: "Test Agent", systemPrompt: "You are a helpful assistant." },
  });
  await prisma.lead.create({ data: { id: leadId, tenantId, name: "Test Lead", email: "lead@example.com" } });
  await prisma.call.create({
    data: {
      id: callId,
      tenantId,
      leadId,
      agentId,
      direction: "outbound",
      status: "completed",
      transcript: "fake transcript for test",
    },
  });

  const fakeIntelligence = {
    summary: "Lead wants a demo next week.",
    outcome: "booked_demo" as const,
    sentiment: "positive" as const,
    intent: "wants a product demo",
    objections: ["price seems high"],
    questions: ["what does pricing look like"],
    follow_up_required: false,
    appointment_requested: true,
    extracted_info: { budget: "$5k/mo", requirements: "10 seats", timeline: "next quarter" },
  };

  const event = {
    event_id: eventId,
    event_type: "call.ended",
    tenant_id: tenantId,
    call_id: callId,
    lead_id: leadId,
    campaign_id: null,
    agent_id: agentId,
    payload: {},
    timestamp: new Date().toISOString(),
  };

  const result = await handleCallEvent(event, { extractFn: async () => fakeIntelligence });

  assert.equal(result.skipped, false);
  assert.equal(result.qualification!.label, "hot");
  assert.ok(result.appointment, "expected an appointment to be auto-booked");

  const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
  assert.equal(call.outcome, "booked_demo");
  assert.equal(call.sentiment, "positive");
  assert.equal(call.summary, "Lead wants a demo next week.");
  const extracted = call.extractedInfo as Record<string, unknown>;
  assert.deepEqual(extracted.objections, ["price seems high"]);
  assert.deepEqual(extracted.questions, ["what does pricing look like"]);
  assert.equal(extracted.follow_up_required, false);
  assert.equal(extracted.appointment_requested, true);
  assert.equal(extracted.budget, "$5k/mo");

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
  const qualification = lead.qualification as Record<string, unknown>;
  assert.equal(qualification.label, "hot");
  assert.equal(qualification.budget, "$5k/mo");

  const appointments = await prisma.appointment.findMany({ where: { callId } });
  assert.equal(appointments.length, 1);
  assert.equal(appointments[0].status, "scheduled");
  assert.equal(appointments[0].confirmationSent, true);

  // Cancellation: status flips, and a second cancel is a safe no-op.
  const cancelResult = await cancelAppointment(appointments[0].id);
  assert.equal(cancelResult.alreadyCancelled, false);
  const cancelled = await prisma.appointment.findUniqueOrThrow({ where: { id: appointments[0].id } });
  assert.equal(cancelled.status, "cancelled");
  const secondCancel = await cancelAppointment(appointments[0].id);
  assert.equal(secondCancel.alreadyCancelled, true);

  // Idempotency: re-processing the same event_id must not double-write or
  // double-book, and must not call extractFn again.
  let extractCallCount = 0;
  const secondResult = await handleCallEvent(event, {
    extractFn: async () => {
      extractCallCount++;
      return fakeIntelligence;
    },
  });
  assert.equal(secondResult.skipped, true);
  assert.equal(extractCallCount, 0, "extractFn must not be called again for an already-processed event");

  // Cleanup
  await prisma.appointment.deleteMany({ where: { tenantId } });
  await prisma.processedCallEvent.deleteMany({ where: { callId } });
  await prisma.call.deleteMany({ where: { tenantId } });
  await prisma.lead.deleteMany({ where: { tenantId } });
  await prisma.agent.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
});
