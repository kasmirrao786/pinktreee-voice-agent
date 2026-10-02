import crypto from 'crypto';
import fetch from 'node-fetch';

// Fires the call.ended event saas-platform's intelligence pipeline
// subscribes to (see saas-platform/src/app/api/webhooks/call-events/route.ts
// for the receiving side - the signature scheme here MUST match it exactly:
// HMAC-SHA256 over the raw JSON body, sent as `X-Signature: sha256=<hex>`).
//
// This used to point at a standalone "intelligence-service" - that service
// was folded into saas-platform (see root README's "Restructuring: three
// services down to two"), so this now points at saas-platform's own
// deployment instead of a separate one. Only the URL/env var name and the
// path changed; the wire format is identical.
//
// Deliberately fire-and-forget from the caller's point of view: a failed
// or slow webhook must never block or crash the call-handling code path.
// The receiving endpoint returns 500 on failure specifically so a sender
// fronted by a real retry queue would retry - this project doesn't
// implement retry itself yet, just logs and moves on. See README for that
// as a known gap.
export async function notifyCallEnded({ tenantId, callId, leadId, campaignId, agentId }) {
  const baseUrl = process.env.SAAS_PLATFORM_URL;
  if (!baseUrl) {
    console.warn('SAAS_PLATFORM_URL is not set - skipping call.ended webhook (the intelligence pipeline will never see this call).');
    return;
  }

  const event = {
    event_id: crypto.randomUUID(),
    event_type: 'call.ended',
    tenant_id: tenantId,
    call_id: callId,
    lead_id: leadId || null,
    campaign_id: campaignId || null,
    agent_id: agentId || null,
    payload: {},
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify(event);
  const headers = { 'Content-Type': 'application/json' };

  const secret = process.env.CALL_EVENTS_WEBHOOK_SECRET;
  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Signature'] = `sha256=${signature}`;
  } else {
    console.warn('CALL_EVENTS_WEBHOOK_SECRET is not set - sending call.ended webhook unsigned. The receiving endpoint will reject it unless its own secret check is also disabled.');
  }

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/webhooks/call-events`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`call.ended webhook to saas-platform failed (${res.status}): ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('call.ended webhook to saas-platform failed:', err.message);
  }
}
