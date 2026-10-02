import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, PageHeader, StatCard } from "@/components/ui";
import { startCampaignAction, pauseCampaignAction, stopCampaignAction } from "@/lib/actions/campaigns";

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const { tenantId } = await requireSession();

  const campaign = await prisma.campaign.findFirst({
    where: { id: params.id, tenantId },
    include: { agent: true, phoneNumber: true },
  });
  if (!campaign) notFound();

  const [calls, leads] = await Promise.all([
    prisma.call.findMany({ where: { tenantId, campaignId: campaign.id }, include: { lead: true }, orderBy: { startedAt: "desc" } }),
    prisma.lead.findMany({ where: { tenantId, campaignId: campaign.id } }),
  ]);

  const total = campaign.leadIds.length || leads.length;
  const pending = Math.max(total - campaign.dialedCount - campaign.skippedCount, 0);

  const schedule = campaign.schedule as
    | { startAt?: string | null; callingWindow?: { start: string; end: string }; days?: string[] }
    | null;
  const retryConfig = campaign.retryConfig as { maxAttempts?: number; retryDelayMinutes?: number } | null;

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title={campaign.name}
        action={
          <div className="flex gap-2">
            {campaign.status === "draft" || campaign.status === "paused" ? (
              <form action={startCampaignAction.bind(null, campaign.id)}>
                <button type="submit" className="btn-primary">
                  {campaign.status === "paused" ? "Resume" : "Start"}
                </button>
              </form>
            ) : campaign.status === "running" ? (
              <form action={pauseCampaignAction.bind(null, campaign.id)}>
                <button type="submit" className="btn-secondary">
                  Pause
                </button>
              </form>
            ) : null}
            {(campaign.status === "running" || campaign.status === "paused") && (
              <form action={stopCampaignAction.bind(null, campaign.id)}>
                <button type="submit" className="btn-danger">
                  Stop
                </button>
              </form>
            )}
          </div>
        }
      />

      <div className="flex items-center gap-3">
        <Badge status={campaign.status} />
        <span className="text-sm text-gray-500">
          {campaign.agent.name} · {campaign.phoneNumber.e164Number}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total leads" value={total} />
        <StatCard label="Dialed" value={campaign.dialedCount} />
        <StatCard label="Skipped" value={campaign.skippedCount} />
        <StatCard label="Pending" value={pending} />
      </div>

      {(schedule || retryConfig) && (
        <div className="card p-6 grid md:grid-cols-2 gap-4 text-sm">
          {schedule && (
            <div>
              <div className="text-gray-500 mb-1">Schedule</div>
              <div>
                Calling window: {schedule.callingWindow?.start}–{schedule.callingWindow?.end}
              </div>
              <div className="capitalize">Days: {schedule.days?.join(", ")}</div>
              {schedule.startAt && <div>Starts: {new Date(schedule.startAt).toLocaleString()}</div>}
            </div>
          )}
          {retryConfig && (
            <div>
              <div className="text-gray-500 mb-1">Retry policy</div>
              <div>Max attempts: {retryConfig.maxAttempts}</div>
              <div>Delay between attempts: {retryConfig.retryDelayMinutes} min</div>
            </div>
          )}
        </div>
      )}

      <div className="card p-6">
        <h2 className="font-medium mb-3">Call results</h2>
        {calls.length === 0 ? (
          <p className="text-sm text-gray-400 italic">
            No calls placed yet. Once this campaign starts, calls from Project 1's dial-queue will appear here.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {calls.map((call) => (
              <li key={call.id} className="py-2.5 flex items-center justify-between text-sm">
                <div>
                  <Link href={`/calls/${call.id}`} className="text-brand-600 hover:underline font-medium">
                    {call.lead?.name || call.lead?.phone || "Unknown lead"}
                  </Link>
                  <div className="text-xs text-gray-500">
                    {call.startedAt ? new Date(call.startedAt).toLocaleString() : "Not started"}
                  </div>
                </div>
                <Badge status={call.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
