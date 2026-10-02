import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, PageHeader } from "@/components/ui";
import ConfirmActionButton from "@/components/ConfirmActionButton";
import { updateLeadAction, addLeadNoteAction, deleteLeadAction } from "@/lib/actions/leads";

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const { tenantId } = await requireSession();

  const lead = await prisma.lead.findFirst({ where: { id: params.id, tenantId } });
  if (!lead) notFound();

  const [calls, appointments] = await Promise.all([
    prisma.call.findMany({ where: { tenantId, leadId: lead.id }, orderBy: { startedAt: "desc" }, include: { agent: true } }),
    prisma.appointment.findMany({ where: { tenantId, leadId: lead.id }, orderBy: { scheduledTime: "desc" } }),
  ]);

  const notes = Array.isArray(lead.notes) ? (lead.notes as { author: string; text: string; createdAt: string }[]) : [];
  const qualification = lead.qualification as
    | { score?: number; label?: string; budget?: string; requirements?: string; timeline?: string; intent?: string }
    | null;

  const boundUpdate = updateLeadAction.bind(null, lead.id);
  const boundAddNote = addLeadNoteAction.bind(null, lead.id);

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader title={lead.name || lead.phone || lead.email || "Lead"} />

      <div className="grid md:grid-cols-2 gap-6">
        <form action={boundUpdate} className="card p-6 space-y-3">
          <h2 className="font-medium mb-1">Details</h2>
          <input name="name" defaultValue={lead.name || ""} placeholder="Name" className="input" />
          <input name="phone" defaultValue={lead.phone || ""} placeholder="Phone" className="input" />
          <input name="email" defaultValue={lead.email || ""} placeholder="Email" className="input" />
          <input name="company" defaultValue={lead.company || ""} placeholder="Company" className="input" />
          <select name="status" defaultValue={lead.status} className="input">
            {["new", "contacted", "qualified", "unqualified", "lost"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input name="tags" defaultValue={lead.tags.join(", ")} placeholder="Tags (comma-separated)" className="input" />
          <button type="submit" className="btn-primary">
            Save
          </button>
        </form>

        <div className="card p-6">
          <h2 className="font-medium mb-3">Qualification (from Project 3)</h2>
          {qualification ? (
            <dl className="text-sm space-y-2">
              {qualification.label && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Label</dt>
                  <dd>
                    <Badge status={qualification.label} />
                  </dd>
                </div>
              )}
              {qualification.score !== undefined && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Score</dt>
                  <dd>{qualification.score}</dd>
                </div>
              )}
              {qualification.budget && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Budget</dt>
                  <dd>{qualification.budget}</dd>
                </div>
              )}
              {qualification.timeline && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Timeline</dt>
                  <dd>{qualification.timeline}</dd>
                </div>
              )}
              {qualification.requirements && (
                <div>
                  <dt className="text-gray-500 mb-1">Requirements</dt>
                  <dd className="text-gray-800">{qualification.requirements}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-gray-400 italic">Processing — qualification will appear here once available.</p>
          )}
        </div>
      </div>

      <div className="card p-6">
        <h2 className="font-medium mb-3">Notes</h2>
        <form action={boundAddNote} className="flex gap-2 mb-4">
          <input name="note" placeholder="Add a note…" className="input" required />
          <button type="submit" className="btn-secondary shrink-0">
            Add
          </button>
        </form>
        {notes.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {notes
              .slice()
              .reverse()
              .map((n, i) => (
                <li key={i} className="text-sm border-l-2 border-brand-200 pl-3">
                  <div>{n.text}</div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {n.author} · {new Date(n.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="card p-6">
        <h2 className="font-medium mb-3">Call history</h2>
        {calls.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No calls yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {calls.map((call) => (
              <li key={call.id} className="py-2.5 flex items-center justify-between text-sm">
                <div>
                  <Link href={`/calls/${call.id}`} className="text-brand-600 hover:underline font-medium">
                    {call.startedAt ? new Date(call.startedAt).toLocaleString() : "Unscheduled"}
                  </Link>
                  <div className="text-xs text-gray-500">{call.agent.name}</div>
                </div>
                <Badge status={call.status} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {appointments.length > 0 && (
        <div className="card p-6">
          <h2 className="font-medium mb-3">Appointments</h2>
          <ul className="divide-y divide-gray-100">
            {appointments.map((a) => (
              <li key={a.id} className="py-2.5 flex items-center justify-between text-sm">
                <span>{new Date(a.scheduledTime).toLocaleString()}</span>
                <Badge status={a.status} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmActionButton
        action={deleteLeadAction.bind(null, lead.id)}
        confirmText={`Delete "${lead.name || lead.phone || lead.email}"? This can't be undone.`}
        label="Delete lead"
        pendingLabel="Deleting…"
        redirectTo="/leads"
      />
    </div>
  );
}
