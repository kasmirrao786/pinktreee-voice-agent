import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import NewCampaignForm from "@/components/NewCampaignForm";

export default async function NewCampaignPage() {
  const { tenantId } = await requireSession();

  const [agents, phoneNumbers, leads] = await Promise.all([
    prisma.agent.findMany({ where: { tenantId, isEnabled: true } }),
    prisma.phoneNumber.findMany({ where: { tenantId } }),
    prisma.lead.findMany({ where: { tenantId, campaignId: null } }),
  ]);

  return (
    <div className="max-w-2xl">
      <PageHeader title="New campaign" />
      <NewCampaignForm agents={agents} phoneNumbers={phoneNumbers} leads={leads} />
    </div>
  );
}
