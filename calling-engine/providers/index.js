import * as twilioProvider from './twilio.js';
import * as telnyxProvider from './telnyx.js';

// Adding a third provider is: write providers/whatever.js implementing the
// same {dial, hangup, ...} shape, add it here. Nothing in server.js's
// call-handling logic (placeCallToNumber, the webhook handlers, CallSession)
// needs to change - they only ever call through getProvider(name).
const registry = {
  twilio: twilioProvider,
  telnyx: telnyxProvider,
};

export function getProvider(name) {
  const provider = registry[name];
  if (!provider) throw new Error(`Unknown telephony provider: "${name}"`);
  return provider;
}

export function listProviderNames() {
  return Object.keys(registry);
}
