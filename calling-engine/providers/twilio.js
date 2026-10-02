import twilio from 'twilio';

// Every function here takes credentials as an explicit argument rather than
// reading a global config - that's what makes this "addable/swappable
// without touching core call-handling logic" real rather than aspirational.
// The caller (server.js today, a per-tenant credential lookup once Project
// 2 ships multi-tenant UI) decides which credentials apply to which call;
// this module doesn't know or care whether there's one tenant or a
// thousand.

export function getClient({ accountSid, authToken }) {
  return twilio(accountSid, authToken);
}

// Twilio's flow is synchronous: dialing returns a call object right away,
// and Twilio fetches TwiML from voiceUrl once the call is answered (see
// /voice in server.js) - unlike Telnyx, there's no separate "start the
// media stream" REST call, so this provider has no startMediaStream export.
export async function dial(credentials, { to, from, voiceUrl, statusCallbackUrl }) {
  const call = await getClient(credentials).calls.create({
    to,
    from,
    url: voiceUrl,
    // Synchronous machine detection: Twilio delays connecting the call
    // until it decides human vs. machine, then passes AnsweredBy to /voice.
    machineDetection: 'DetectMessageEnd',
    machineDetectionTimeout: 15,
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });
  return { providerCallId: call.sid, status: call.status };
}

export async function hangup(credentials, providerCallId) {
  await getClient(credentials).calls(providerCallId).update({ status: 'completed' });
}

// Standard Twilio call-transfer pattern: replace whatever TwiML is
// currently running on the live call (our <Connect><Stream>) with a <Dial>
// to the human's number. Twilio bridges the caller to that number once it
// answers. Our media stream ends as soon as this takes effect - this is a
// hand-off, not a 3-way conference where the AI stays on the line to relay
// context to the human first.
export async function transfer(credentials, providerCallId, toNumber) {
  const twiml = `<Response><Dial>${toNumber}</Dial></Response>`;
  await getClient(credentials).calls(providerCallId).update({ twiml });
}

// Twilio signs every webhook request with the account's Auth Token -
// confirms a request actually came from Twilio before acting on it.
// Returns null (rather than throwing) if authToken is missing, so the
// caller can decide whether "can't verify" should mean "reject" or "allow
// with a warning" (server.js currently chooses the latter, permissively).
export function verifyWebhookSignature({ authToken }, { signature, url, params }) {
  if (!authToken) return null;
  return twilio.validateRequest(authToken, signature || '', url, params);
}
