// Cheap, synchronous, deterministic check for explicit opt-out language -
// no LLM round trip needed for this. Runs at call-end so a caller who says
// "take me off your list" can never be dialed again by a fast-moving
// campaign, without waiting on Project 3's async intelligence pipeline
// (which now owns full outcome/summary classification - see
// finalizeCallLog in server.js for why the old single combined classifier
// call was removed).
//
// Deliberately conservative: false negatives (missing a real opt-out) are
// recoverable - Project 3's fuller analysis will likely still catch it and
// a human can act on it. False positives (auto-DNC'ing someone who didn't
// ask for it) are the worse failure mode, so the phrase list stays narrow
// and literal rather than trying to infer intent.
const DNC_PHRASES = [
  'stop calling',
  'don\'t call again',
  'do not call again',
  'do not call me',
  'take me off your list',
  'take me off the list',
  'remove me from your list',
  'remove me from the list',
  'never call me again',
  'stop contacting me',
];

export function detectDncRequest(transcriptText) {
  if (!transcriptText) return false;
  const normalized = transcriptText.toLowerCase();
  return DNC_PHRASES.some((phrase) => normalized.includes(phrase));
}
