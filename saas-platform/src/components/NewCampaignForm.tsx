"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { Agent, PhoneNumber, Lead } from "@prisma/client";
import { createCampaignAction } from "@/lib/actions/campaigns";

type State = { error?: string } | undefined;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Creating…" : "Create campaign"}
    </button>
  );
}

export default function NewCampaignForm({
  agents,
  phoneNumbers,
  leads,
}: {
  agents: Agent[];
  phoneNumbers: PhoneNumber[];
  leads: Lead[];
}) {
  const [state, formAction] = useFormState<State, FormData>(
    async (_prev, formData) => createCampaignAction(formData),
    undefined
  );

  return (
    <form action={formAction} className="space-y-6">
      <div className="card p-6 space-y-4">
        <div>
          <label className="label">Campaign name</label>
          <input name="name" required className="input" placeholder="Spring visa consult outreach" />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">Agent</label>
            <select name="agentId" required className="input">
              <option value="">Select an agent…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Phone number</label>
            <select name="phoneNumberId" required className="input">
              <option value="">Select a number…</option>
              {phoneNumbers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.e164Number} ({p.provider})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <h2 className="font-medium">Schedule</h2>
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="label">Start date &amp; time</label>
            <input type="datetime-local" name="startAt" className="input" />
            <p className="text-xs text-gray-400 mt-1">Leave blank to start manually.</p>
          </div>
          <div>
            <label className="label">Calling window — from</label>
            <input type="time" name="windowStart" defaultValue="09:00" className="input" />
          </div>
          <div>
            <label className="label">Calling window — to</label>
            <input type="time" name="windowEnd" defaultValue="18:00" className="input" />
          </div>
        </div>
        <div>
          <label className="label">Days to call</label>
          <div className="flex flex-wrap gap-3">
            {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => (
              <label key={day} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  name="days"
                  value={day}
                  defaultChecked={!["sat", "sun"].includes(day)}
                  className="rounded"
                />
                <span className="capitalize">{day}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <h2 className="font-medium">Retry settings</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">Max attempts per lead</label>
            <input type="number" name="maxAttempts" min={1} max={10} defaultValue={3} className="input" />
          </div>
          <div>
            <label className="label">Delay between attempts (minutes)</label>
            <input type="number" name="retryDelayMinutes" min={5} defaultValue={60} className="input" />
          </div>
        </div>
      </div>

      <div className="card p-6">
        <label className="label">Leads to include</label>
        {leads.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No unassigned leads available — add or import leads first.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-100">
            {leads.map((lead) => (
              <label key={lead.id} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50">
                <input type="checkbox" name="leadIds" value={lead.id} className="rounded" />
                <span>{lead.name || lead.phone || lead.email || lead.id}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {state?.error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{state.error}</p>
      )}

      <SubmitButton />
    </form>
  );
}
