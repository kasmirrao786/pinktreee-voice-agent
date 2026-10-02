import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import ConfirmActionButton from "@/components/ConfirmActionButton";
import { decryptCredential, maskCredential } from "@/lib/crypto";
import {
  saveProviderCredentialAction,
  removeProviderCredentialAction,
  verifyProviderConnectionAction,
} from "@/lib/actions/telephony";

const PROVIDERS = [
  { id: "twilio", label: "Twilio", fieldLabel: "Auth Token" },
  { id: "telnyx", label: "Telnyx", fieldLabel: "API Key" },
];

export default async function TelephonyPage() {
  const { tenantId, role } = await requireSession();
  const canEdit = role === "owner" || role === "admin";

  const [credentials, phoneNumbers] = await Promise.all([
    prisma.providerCredential.findMany({ where: { tenantId } }),
    prisma.phoneNumber.findMany({ where: { tenantId } }),
  ]);
  const credByProvider = Object.fromEntries(credentials.map((c) => [c.provider, c]));

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Telephony providers" />
      <p className="text-sm text-gray-500 -mt-4">
        Connect your own Telnyx and/or Twilio account. Credentials are encrypted before storage and are never
        shown in full again — only a masked reference.
      </p>

      {PROVIDERS.map((p) => {
        const cred = credByProvider[p.id];
        const masked = cred ? maskCredential(decryptCredential(cred.encryptedValue)) : null;
        const numbersForProvider = phoneNumbers.filter((n) => n.provider === p.id);

        return (
          <div key={p.id} className="card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{p.label}</h2>
              {cred ? (
                <span className="badge bg-green-100 text-green-700">Connected</span>
              ) : (
                <span className="badge bg-gray-100 text-gray-600">Not connected</span>
              )}
            </div>

            {cred ? (
              <div className="space-y-3">
                <div className="text-sm text-gray-600">
                  {p.fieldLabel}: <span className="font-mono">{masked}</span>
                </div>

                {numbersForProvider.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Available phone numbers</div>
                    <ul className="text-sm space-y-1">
                      {numbersForProvider.map((n) => (
                        <li key={n.id} className="font-mono">
                          {n.e164Number}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="flex gap-3">
                  {canEdit ? (
                    <>
                      <form action={verifyProviderConnectionAction.bind(null, p.id)}>
                        <button type="submit" className="btn-secondary">
                          Verify &amp; sync numbers
                        </button>
                      </form>
                      <ConfirmActionButton
                        action={removeProviderCredentialAction.bind(null, p.id)}
                        confirmText={`Disconnect ${p.label}? Its phone numbers will be removed from any unassigned agents.`}
                        label="Disconnect"
                        pendingLabel="Disconnecting…"
                      />
                    </>
                  ) : (
                    <p className="text-xs text-gray-400">Ask a workspace owner or admin to manage this connection.</p>
                  )}
                </div>
              </div>
            ) : canEdit ? (
              <form action={saveProviderCredentialAction} className="space-y-3">
                <input type="hidden" name="provider" value={p.id} />
                <div>
                  <label className="label">{p.fieldLabel}</label>
                  <input name="value" type="password" required className="input" placeholder="Paste your credential" />
                </div>
                <button type="submit" className="btn-primary">
                  Connect {p.label}
                </button>
              </form>
            ) : (
              <p className="text-sm text-gray-400 italic">Not connected yet.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
