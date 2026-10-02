import crypto from 'crypto';

// Same reasoning as providers/twilio.js: every function takes credentials
// explicitly, nothing here reads a global config. Not verified against a
// live Telnyx account from the sandbox this was built in - the
// request/webhook shapes match Telnyx's published API reference as of when
// this was written, but test a real outbound call before relying on it.

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

async function request({ apiKey }, method, pathSuffix, body) {
  const res = await fetch(`${TELNYX_API_BASE}${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || res.statusText;
    throw new Error(`Telnyx API error (${res.status}): ${detail}`);
  }
  return data;
}

// Telnyx's dial call returns before the call connects - everything past
// this point (machine detection, opening the media stream, voicemail
// playback) is driven by webhooks to whatever webhookUrl is given here.
export async function dial(credentials, { to, from, webhookUrl }) {
  const result = await request(credentials, 'POST', '/calls', {
    connection_id: credentials.connectionId,
    to,
    from,
    webhook_url: webhookUrl,
    answering_machine_detection: 'premium',
  });
  return { providerCallId: result.data.call_control_id, status: 'queued' };
}

export async function hangup(credentials, providerCallId) {
  await request(credentials, 'POST', `/calls/${providerCallId}/actions/hangup`);
}

// Bridges the live call to a new destination (Telnyx creates a second leg,
// dials toNumber, and connects the two once it answers). Same hand-off
// semantics as providers/twilio.js's transfer() - the AI's media stream
// ends once the bridge completes, this isn't a 3-way conference.
export async function transfer(credentials, providerCallId, toNumber) {
  await request(credentials, 'POST', `/calls/${providerCallId}/actions/transfer`, { to: toNumber });
}

// Inbound-only: Telnyx parks a ringing inbound call until you explicitly
// answer it. Twilio has no equivalent - returning TwiML from the inbound
// webhook implicitly answers the call, so providers/twilio.js has no
// answer() export.
export async function answer(credentials, providerCallId) {
  await request(credentials, 'POST', `/calls/${providerCallId}/actions/answer`);
}

// Opens the bidirectional media stream to streamUrl for a live call - the
// Telnyx equivalent of Twilio's <Connect><Stream> in /voice, except it's a
// REST command instead of something returned from a webhook fetch.
export async function startMediaStream(credentials, providerCallId, { streamUrl, customParameters }) {
  return request(credentials, 'POST', `/calls/${providerCallId}/actions/streaming_start`, {
    stream_url: streamUrl,
    stream_track: 'inbound_track',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU', // G.711 mu-law - matches this app's mulaw/8kHz pipeline directly, no transcoding
    stream_bidirectional_sampling_rate: 8000,
    custom_parameters: customParameters,
  });
}

export async function playAudio(credentials, providerCallId, audioUrl) {
  return request(credentials, 'POST', `/calls/${providerCallId}/actions/playback_start`, { audio_url: audioUrl });
}

export async function speak(credentials, providerCallId, text) {
  return request(credentials, 'POST', `/calls/${providerCallId}/actions/speak`, {
    payload: text,
    voice: 'female',
    language: 'en-US',
  });
}

// Telnyx signs with Ed25519 over "{timestamp}|{raw body}". The signing key
// is account-level (not per-connection/per-tenant the way API keys are),
// so publicKeyBase64 is passed in separately from `credentials` rather than
// read off it - server.js sources it from TELNYX_PUBLIC_KEY.
export function verifyWebhookSignature(publicKeyBase64, { signatureHeader, timestampHeader, rawBody }) {
  if (!publicKeyBase64) return null;
  if (!signatureHeader || !timestampHeader || !rawBody) return false;

  // Reject anything older than 5 minutes - stops a captured request from
  // being replayed later.
  const timestamp = parseInt(timestampHeader, 10);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  try {
    const signedPayload = `${timestampHeader}|${rawBody.toString('utf-8')}`;
    const publicKeyBytes = Buffer.from(publicKeyBase64, 'base64');
    const keyObject = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBytes.toString('base64url') },
      format: 'jwk',
    });
    return crypto.verify(null, Buffer.from(signedPayload), keyObject, Buffer.from(signatureHeader, 'base64'));
  } catch (err) {
    console.error('Telnyx signature verification error:', err.message);
    return false;
  }
}
