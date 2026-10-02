import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import { updatePlatformSettingsAction } from "@/lib/actions/admin";

export default async function AdminSettingsPage() {
  const settings = await prisma.platformSetting.findMany();
  const byKey = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  const ingestionEndpointUrl = (byKey.ingestion_endpoint_url as string) || "";
  const retryPolicy = (byKey.default_retry_policy as { defaultMaxAttempts?: number; defaultRetryDelayMinutes?: number }) || {};
  const availableVoices = (byKey.available_voices as string[]) || [];

  return (
    <div className="max-w-xl">
      <PageHeader title="System &amp; provider configuration" />

      <form action={updatePlatformSettingsAction} className="card p-6 space-y-5">
        <div>
          <label className="label">Knowledge-base ingestion endpoint (Project 1)</label>
          <input
            name="ingestionEndpointUrl"
            defaultValue={ingestionEndpointUrl}
            className="input"
            placeholder="https://calling-engine.internal/ingest"
          />
          <p className="text-xs text-gray-400 mt-1">
            Called whenever a customer adds or edits a knowledge source. Overrides INGESTION_ENDPOINT_URL.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Default max call attempts</label>
            <input
              type="number"
              name="defaultMaxAttempts"
              min={1}
              max={10}
              defaultValue={retryPolicy.defaultMaxAttempts ?? 3}
              className="input"
            />
          </div>
          <div>
            <label className="label">Default retry delay (minutes)</label>
            <input
              type="number"
              name="defaultRetryDelayMinutes"
              min={5}
              defaultValue={retryPolicy.defaultRetryDelayMinutes ?? 60}
              className="input"
            />
          </div>
        </div>

        <div>
          <label className="label">Available voices (comma-separated IDs)</label>
          <input
            name="availableVoices"
            defaultValue={availableVoices.join(", ")}
            className="input"
            placeholder="voice_amara, voice_leo, voice_priya"
          />
          <p className="text-xs text-gray-400 mt-1">
            Informational for now — the agent form's voice list is still hardcoded in AgentForm.tsx; wire it up to
            this setting when voice options need to change without a deploy.
          </p>
        </div>

        <button type="submit" className="btn-primary">
          Save settings
        </button>
      </form>
    </div>
  );
}
