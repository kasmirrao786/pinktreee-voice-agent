import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import AgentForm from "@/components/AgentForm";
import ConfirmActionButton from "@/components/ConfirmActionButton";
import { updateAgentAction, deleteAgentAction } from "@/lib/actions/agents";
import { createKnowledgeSourceAction, deleteKnowledgeSourceAction, uploadKnowledgeFileAction } from "@/lib/actions/knowledge";

export default async function AgentDetailPage({ params }: { params: { id: string } }) {
  const { tenantId, role } = await requireSession();
  const canEdit = role === "owner" || role === "admin";

  const agent = await prisma.agent.findFirst({ where: { id: params.id, tenantId } });
  if (!agent) notFound();

  const [phoneNumbers, sources] = await Promise.all([
    prisma.phoneNumber.findMany({ where: { tenantId } }),
    prisma.knowledgeSource.findMany({
      where: { tenantId, agentId: agent.id },
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const boundUpdate = updateAgentAction.bind(null, agent.id);
  const boundCreateSource = createKnowledgeSourceAction.bind(null, agent.id);
  const boundUploadFile = uploadKnowledgeFileAction.bind(null, agent.id);

  return (
    <div className="max-w-2xl space-y-10">
      <PageHeader title={agent.name} />

      {canEdit ? (
        <AgentForm action={boundUpdate} agent={agent} phoneNumbers={phoneNumbers} submitLabel="Save changes" />
      ) : (
        <div className="card p-6 space-y-2 text-sm">
          <p className="text-gray-500">
            You have view-only access. Ask a workspace owner or admin to change this agent&apos;s configuration.
          </p>
          <div>
            <span className="text-gray-500">Voice: </span>
            {agent.voiceId || "—"}
          </div>
          <div>
            <span className="text-gray-500">Model: </span>
            {agent.llmModel || "—"}
          </div>
          <div>
            <span className="text-gray-500">System prompt: </span>
            <pre className="whitespace-pre-wrap font-sans mt-1">{agent.systemPrompt}</pre>
          </div>
        </div>
      )}

      <section className="card p-6 space-y-4">
        <h2 className="font-medium">Knowledge base</h2>
        <p className="text-sm text-gray-500">
          Documents, FAQs, and website sources this agent can reference during calls. Sources are stored raw
          here; chunking and embeddings are generated asynchronously.
        </p>

        {canEdit && (
          <div className="grid md:grid-cols-2 gap-4">
            <form action={boundCreateSource} className="space-y-2 border border-gray-100 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500">Paste text / FAQ or a website URL</div>
              <select name="type" className="input" defaultValue="text">
                <option value="text">Text / FAQ</option>
                <option value="url">Website URL</option>
              </select>
              <textarea name="rawContent" rows={2} placeholder="Paste FAQ or text content…" className="input" />
              <input name="sourceUrl" placeholder="https://example.com/faq" className="input" />
              <button type="submit" className="btn-secondary w-full">
                Add source
              </button>
            </form>

            <form action={boundUploadFile} className="space-y-2 border border-gray-100 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500">Upload a document</div>
              <input
                type="file"
                name="file"
                required
                accept=".txt,.md,.csv,.pdf,.doc,.docx"
                className="block w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
              />
              <p className="text-xs text-gray-400">
                Text-based files (.txt, .md, .csv) are indexed immediately; PDFs/Word docs are stored and picked up
                by the ingestion pipeline.
              </p>
              <button type="submit" className="btn-secondary w-full">
                Upload
              </button>
            </form>
          </div>
        )}

        {sources.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No knowledge sources added yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {sources.map((source) => {
              const status = source._count.chunks > 0 ? "indexed" : "processing";
              const boundDelete = deleteKnowledgeSourceAction.bind(null, agent.id, source.id);
              return (
                <li key={source.id} className="py-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium capitalize">{source.type}</div>
                    <div className="text-sm text-gray-500 truncate">
                      {source.type === "file" && source.sourceUrl ? (
                        <a href={`/api/knowledge-files/${source.id}`} className="text-brand-600 hover:underline">
                          {source.sourceUrl.split("/").pop()?.replace(/^[0-9a-f-]{36}-/, "")}
                        </a>
                      ) : (
                        source.sourceUrl || source.rawContent || "—"
                      )}
                    </div>
                    <div className={`text-xs mt-1 ${status === "indexed" ? "text-green-600" : "text-amber-600"}`}>
                      {status}
                    </div>
                  </div>
                  {canEdit && (
                    <form action={boundDelete}>
                      <button type="submit" className="text-sm text-red-600 hover:underline shrink-0">
                        Delete
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canEdit && (
        <section className="card p-6 border-red-100">
          <h2 className="font-medium text-red-700 mb-2">Danger zone</h2>
          <p className="text-sm text-gray-500 mb-4">
            Deleting this agent removes its configuration and knowledge sources. Agents with call or campaign
            history can't be deleted — disable them instead.
          </p>
          <ConfirmActionButton
            action={deleteAgentAction.bind(null, agent.id)}
            confirmText={`Delete "${agent.name}"? This can't be undone.`}
            label="Delete agent"
            pendingLabel="Deleting…"
            className="btn-danger"
            redirectTo="/agents"
          />
        </section>
      )}
    </div>
  );
}
