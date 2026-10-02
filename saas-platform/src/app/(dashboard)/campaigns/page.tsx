import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, PageHeader } from "@/components/ui";

export default async function CampaignsPage() {
  const { tenantId } = await requireSession();
  const campaigns = await prisma.campaign.findMany({
    where: { tenantId },
    include: { agent: true, phoneNumber: true },
    orderBy: { startedAt: "desc" },
  });

  return (
    <div>
      <PageHeader
        title="Campaigns"
        action={
          <Link href="/campaigns/new" className="btn-primary">
            + New campaign
          </Link>
        }
      />

      {campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet" description="Create a campaign to start dialing a list of leads." />
      ) : (
        <div className="card divide-y divide-gray-100">
          {campaigns.map((c) => {
            const total = c.leadIds.length;
            const progress = total > 0 ? Math.round(((c.dialedCount + c.skippedCount) / total) * 100) : 0;
            return (
              <Link key={c.id} href={`/campaigns/${c.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-gray-50">
                <div>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-sm text-gray-500">
                    {c.agent.name} · {c.phoneNumber.e164Number} · {total} leads
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>{progress}% dialed</span>
                  <Badge status={c.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
