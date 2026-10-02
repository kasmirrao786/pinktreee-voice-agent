"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { Agent, PhoneNumber } from "@prisma/client";
import type { AgentFormState } from "@/lib/actions/agents";

const VOICES = [
  { id: "voice_amara", label: "Amara (warm, US English)" },
  { id: "voice_leo", label: "Leo (professional, US English)" },
  { id: "voice_priya", label: "Priya (friendly, Indian English)" },
  { id: "voice_omar", label: "Omar (calm, UK English)" },
];

const LLM_MODELS = [
  { id: "gpt-4o-mini", label: "GPT-4o mini — fast, low cost" },
  { id: "gpt-4o", label: "GPT-4o — higher quality" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — fast, low cost" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 — higher quality" },
  { id: "llama-3-70b", label: "Llama 3 70B (self-hosted)" },
];

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export default function AgentForm({
  action,
  agent,
  phoneNumbers,
  submitLabel,
  extra,
}: {
  action: (prev: AgentFormState, formData: FormData) => Promise<AgentFormState>;
  agent?: Agent | null;
  phoneNumbers: PhoneNumber[];
  submitLabel: string;
  extra?: React.ReactNode;
}) {
  const [state, formAction] = useFormState(action, undefined);

  return (
    <form action={formAction} className="space-y-6">
      <div className="card p-6 space-y-4">
        <h2 className="font-medium">Basics</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">Agent name</label>
            <input name="name" required defaultValue={agent?.name} className="input" placeholder="Visa Consult Inbound" />
          </div>
          <div>
            <label className="label">Voice</label>
            <select name="voiceId" defaultValue={agent?.voiceId || ""} className="input">
              <option value="">Select a voice…</option>
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">LLM / model</label>
          <select name="llmModel" defaultValue={agent?.llmModel || ""} className="input">
            <option value="">Select a model…</option>
            {LLM_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Description</label>
          <input name="description" defaultValue={agent?.description || ""} className="input" placeholder="What this agent is for" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isEnabled" defaultChecked={agent?.isEnabled ?? true} className="rounded" />
          Agent enabled (can take/make calls)
        </label>
      </div>

      <div className="card p-6 space-y-4">
        <h2 className="font-medium">Behavior</h2>
        <div>
          <label className="label">System prompt</label>
          <textarea
            name="systemPrompt"
            required
            rows={6}
            defaultValue={agent?.systemPrompt}
            className="input font-mono text-xs"
            placeholder="You are a helpful assistant for..."
          />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">Greeting message</label>
            <textarea name="greetingMessage" rows={2} defaultValue={agent?.greetingMessage || ""} className="input" />
          </div>
          <div>
            <label className="label">Closing message</label>
            <textarea name="closingMessage" rows={2} defaultValue={agent?.closingMessage || ""} className="input" />
          </div>
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <h2 className="font-medium">Transfer &amp; phone number</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">Transfer number</label>
            <input name="transferNumber" defaultValue={agent?.transferNumber || ""} className="input" placeholder="+15551234567" />
          </div>
          <div>
            <label className="label">Assigned phone number</label>
            <select name="assignedPhoneNumberId" defaultValue={agent?.assignedPhoneNumberId || ""} className="input">
              <option value="">Unassigned</option>
              {phoneNumbers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.e164Number} ({p.provider})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">Transfer conditions (one per line)</label>
          <textarea
            name="transferConditions"
            rows={3}
            defaultValue={agent?.transferConditions?.join("\n") || ""}
            className="input"
            placeholder={"Caller asks for a human\nCaller mentions a complaint"}
          />
        </div>
      </div>

      {extra}

      {state?.error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{state.error}</p>
      )}

      <SubmitButton label={submitLabel} />
    </form>
  );
}
