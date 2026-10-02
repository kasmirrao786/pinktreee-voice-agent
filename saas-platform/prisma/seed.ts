import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding fixture data…");

  // --- Platform admin (separate from any tenant's customer accounts) ---
  const adminTenant = await prisma.tenant.upsert({
    where: { id: "internal-platform" },
    update: {},
    create: { id: "internal-platform", name: "PinkTree Internal", plan: "internal", isActive: true },
  });
  await prisma.user.upsert({
    where: { email: "admin@pinktreee.com" },
    update: {},
    create: {
      tenantId: adminTenant.id,
      email: "admin@pinktreee.com",
      passwordHash: await bcrypt.hash("changeme123", 12),
      role: "platform_admin",
    },
  });

  // --- Demo customer tenant ---
  const tenant = await prisma.tenant.upsert({
    where: { id: "demo-tenant" },
    update: {},
    create: { id: "demo-tenant", name: "Acme Visa Consultants", plan: "growth", isActive: true },
  });

  await prisma.user.upsert({
    where: { email: "demo@acme.test" },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "demo@acme.test",
      passwordHash: await bcrypt.hash("changeme123", 12),
      role: "owner",
    },
  });

  // A second teammate so the team-management UI has something to show.
  await prisma.user.upsert({
    where: { email: "teammate@acme.test" },
    update: {},
    create: {
      tenantId: tenant.id,
      email: "teammate@acme.test",
      passwordHash: await bcrypt.hash("changeme123", 12),
      role: "member",
    },
  });

  await prisma.platformSetting.upsert({
    where: { key: "default_retry_policy" },
    update: {},
    create: { key: "default_retry_policy", value: { defaultMaxAttempts: 3, defaultRetryDelayMinutes: 60 } },
  });

  const phoneNumber = await prisma.phoneNumber.create({
    data: { tenantId: tenant.id, provider: "twilio", e164Number: "+15005550006" },
  });

  const agent = await prisma.agent.create({
    data: {
      tenantId: tenant.id,
      name: "Visa Consult Inbound",
      description: "Handles inbound calls about visa consultation services",
      systemPrompt:
        "You are a friendly, professional voice assistant for a visa consultancy. Answer questions about services, qualify leads, and book consultations.",
      voiceId: "voice_amara",
      llmModel: "gpt-4o-mini",
      isEnabled: true,
      greetingMessage: "Thanks for calling Acme Visa Consultants — how can I help you today?",
      closingMessage: "Thanks for calling, we'll be in touch soon!",
      transferConditions: ["Caller asks for a human", "Caller mentions a complaint"],
      assignedPhoneNumberId: phoneNumber.id,
    },
  });

  await prisma.knowledgeSource.create({
    data: {
      tenantId: tenant.id,
      agentId: agent.id,
      type: "text",
      rawContent: "We offer H1-B, student visa, and green card consultation services starting at $199/session.",
    },
  });

  const leadStatuses = ["new", "contacted", "qualified", "unqualified"];
  const leads = await Promise.all(
    Array.from({ length: 6 }).map((_, i) =>
      prisma.lead.create({
        data: {
          tenantId: tenant.id,
          name: `Fixture Lead ${i + 1}`,
          phone: `+1500555${1000 + i}`,
          email: `lead${i + 1}@example.test`,
          company: i % 2 === 0 ? "Example Corp" : null,
          status: leadStatuses[i % leadStatuses.length],
          tags: i % 2 === 0 ? ["referral"] : [],
          source: "manual",
          qualification:
            i % 3 === 0
              ? { score: 82, label: "qualified", budget: "$5k-10k", timeline: "1-3 months", intent: "H1-B transfer" }
              : undefined,
        },
      })
    )
  );

  const campaign = await prisma.campaign.create({
    data: {
      tenantId: tenant.id,
      name: "Spring outreach",
      agentId: agent.id,
      phoneNumberId: phoneNumber.id,
      status: "running",
      leadIds: leads.map((l) => l.id),
      dialedCount: 3,
      skippedCount: 1,
      startedAt: new Date(Date.now() - 1000 * 60 * 60 * 24),
      retryConfig: { maxAttempts: 3, retryDelayMinutes: 60 },
    },
  });

  await prisma.lead.updateMany({
    where: { id: { in: leads.map((l) => l.id) } },
    data: { campaignId: campaign.id },
  });

  const callOutcomes = ["appointment_booked", "not_interested", "voicemail", "callback_requested"];
  for (let i = 0; i < 4; i++) {
    const lead = leads[i];
    const startedAt = new Date(Date.now() - 1000 * 60 * 60 * (24 - i * 3));
    await prisma.call.create({
      data: {
        tenantId: tenant.id,
        leadId: lead.id,
        campaignId: campaign.id,
        agentId: agent.id,
        phoneNumberId: phoneNumber.id,
        direction: "outbound",
        status: "completed",
        startedAt,
        endedAt: new Date(startedAt.getTime() + 1000 * 60 * 4),
        durationSeconds: 240,
        transcript: "Agent: Hi, this is Acme Visa Consultants...\nLead: Sure, tell me more.",
        summary: "Lead was interested in H1-B transfer consultation and requested a follow-up call.",
        outcome: callOutcomes[i % callOutcomes.length],
        sentiment: i % 2 === 0 ? "positive" : "neutral",
        extractedInfo: { budget: "$5k-10k", timeline: "1-3 months", intent: "H1-B transfer" },
      },
    });
  }

  await prisma.appointment.create({
    data: {
      tenantId: tenant.id,
      leadId: leads[0].id,
      agentId: agent.id,
      scheduledTime: new Date(Date.now() + 1000 * 60 * 60 * 24 * 2),
      status: "scheduled",
      confirmationSent: true,
    },
  });

  console.log("Seed complete.");
  console.log("Customer owner login: demo@acme.test / changeme123");
  console.log("Customer member login: teammate@acme.test / changeme123");
  console.log("Platform admin login: admin@pinktreee.com / changeme123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
