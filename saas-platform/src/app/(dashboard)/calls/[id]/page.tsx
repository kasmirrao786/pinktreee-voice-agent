import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, PageHeader } from "@/components/ui";

export default async function CallDetailPage({ params }: { params: { id: string } }) {
  const { tenantId } = await requireSession();

  const call = await prisma.call.findFirst({
    where: { id: params.id, tenantId },
    include: { lead: true, agent: true, campaign: true },
  });
  if (!call) notFound();

  const extractedInfo = call.extractedInfo as
    | { budget?: string; requirements?: string; timeline?: string; intent?: string }
    | null;
  const isProcessing = call.status === "completed" && !call.summary;

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Call detail" />

      <div className="card p-6 grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-gray-500">Lead</div>
          <div className="font-medium">
            {call.lead ? (
              <Link href={`/leads/${call.lead.id}`} className="text-brand-600 hover:underline">
                {call.lead.name || call.lead.phone || call.lead.email}
              </Link>
            ) : (
              "—"
            )}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Agent</div>
          <div className="font-medium">{call.agent.name}</div>
        </div>
        <div>
          <div className="text-gray-500">Campaign</div>
          <div className="font-medium">
            {call.campaign ? (
              <Link href={`/campaigns/${call.campaign.id}`} className="text-brand-600 hover:underline">
                {call.campaign.name}
              </Link>
            ) : (
              "—"
            )}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Direction</div>
          <div className="font-medium capitalize">{call.direction}</div>
        </div>
        <div>
          <div className="text-gray-500">Status</div>
          <Badge status={call.status} />
        </div>
        <div>
          <div className="text-gray-500">Duration</div>
          <div className="font-medium">{call.durationSeconds ? `${Math.round(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s` : "—"}</div>
        </div>
      </div>

      {call.recordingUrl && (
        <div className="card p-6">
          <h2 className="font-medium mb-3">Recording</h2>
          <audio controls src={call.recordingUrl} className="w-full" />
        </div>
      )}

      <div className="card p-6">
        <h2 className="font-medium mb-3">Summary &amp; outcome</h2>
        {isProcessing ? (
          <p className="text-sm text-amber-600 italic">Processing — summary and outcome will appear here shortly.</p>
        ) : (
          <div className="space-y-2 text-sm">
            {call.summary && <p>{call.summary}</p>}
            {call.outcome && (
              <div>
                <span className="text-gray-500">Outcome: </span>
                <Badge status={call.outcome} />
              </div>
            )}
            {call.sentiment && (
              <div>
                <span className="text-gray-500">Sentiment: </span>
                <span className="capitalize">{call.sentiment}</span>
              </div>
            )}
            {call.transferTriggered && (
              <div className="text-gray-500">
                Transferred{call.transferReason ? ` — ${call.transferReason}` : ""}
              </div>
            )}
          </div>
        )}
      </div>

      {extractedInfo && (
        <div className="card p-6">
          <h2 className="font-medium mb-3">Extracted lead info</h2>
          <dl className="text-sm grid grid-cols-2 gap-y-2">
            {extractedInfo.budget && (
              <>
                <dt className="text-gray-500">Budget</dt>
                <dd>{extractedInfo.budget}</dd>
              </>
            )}
            {extractedInfo.timeline && (
              <>
                <dt className="text-gray-500">Timeline</dt>
                <dd>{extractedInfo.timeline}</dd>
              </>
            )}
            {extractedInfo.intent && (
              <>
                <dt className="text-gray-500">Intent</dt>
                <dd>{extractedInfo.intent}</dd>
              </>
            )}
            {extractedInfo.requirements && (
              <>
                <dt className="text-gray-500">Requirements</dt>
                <dd>{extractedInfo.requirements}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="card p-6">
        <h2 className="font-medium mb-3">Transcript</h2>
        {call.transcript ? (
          <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">{call.transcript}</pre>
        ) : (
          <p className="text-sm text-gray-400 italic">No transcript available.</p>
        )}
      </div>
    </div>
  );
}
