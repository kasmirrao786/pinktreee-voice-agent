import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

// Deliberately does NOT throw if DATABASE_URL is unset - server.js checks
// `dbEnabled` and falls back to the original flat-file storage when it's
// false, so this module can be imported unconditionally without forcing
// Postgres to exist yet.
export const dbEnabled = !!process.env.DATABASE_URL;

export const pool = dbEnabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message);
  });
}

// ---- Schema ownership -------------------------------------------------------
// The canonical schema is prisma/schema.prisma in the saas-platform project
// - EVERY table this service reads or writes, including `dnc_numbers`, is
// created and owned there. This module does not run its own CREATE TABLE
// for anything.
//
// Correction made during the 3-services-to-2 restructuring: this used to
// say "dnc_numbers is the one table this project exclusively owns" and ran
// its own competing CREATE TABLE for it (db/dnc_schema.sql, now deleted) -
// but a DncNumber model had ALSO been added to schema.prisma during the
// original integration pass, so both a Prisma migration and this service's
// own migration were creating the same table with slightly different
// column types (TIMESTAMPTZ here vs. Prisma's TIMESTAMP(3)). Harmless only
// because saas-platform always deployed first in every environment this
// was tested in (IF NOT EXISTS made this service's version a no-op) - but
// a real risk of drift the moment deploy order was ever violated for real.
// Found by re-checking the schema for duplicate @@map table names while
// restructuring, not by anything failing at runtime - exactly the kind of
// thing worth periodically re-auditing for, since it's invisible until it
// isn't.
export async function migrate() {
  if (!dbEnabled) return;
  console.log('Nothing to migrate here - every table this service uses (including dnc_numbers) is owned by the saas-platform Prisma schema. Run `npm run db:push` there first.');
}

// IDs: the canonical schema's `id String @id @default(cuid())` computes the
// cuid CLIENT-SIDE in Prisma's own code - there is no database-level
// DEFAULT on these columns. Since this service writes via raw SQL, not the
// Prisma client, every INSERT here must supply its own id explicitly.
// crypto.randomUUID() produces a valid value for a TEXT primary key column
// (it doesn't need to look like a cuid, just be unique) - functionally
// identical, only cosmetically different from what Prisma would generate.
function newId() {
  return crypto.randomUUID();
}

// ---- Credential encryption --------------------------------------------------
// MUST use the exact same scheme as saas-platform/src/lib/crypto.ts, since
// this project reads credentials Project 2 wrote: AES-256-GCM, a random
// 12-byte nonce per value, packed as nonce+ciphertext+authTag and
// base64-encoded into one string. Both services read
// CREDENTIAL_ENCRYPTION_KEY (base64, 32 bytes) - note the singular
// "CREDENTIAL", not "CREDENTIALS" as this project used before integration;
// if you have an old .env with the plural name, rename it.
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getMasterKey() {
  const b64 = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    console.warn('CREDENTIAL_ENCRYPTION_KEY does not decode to 32 bytes - ignoring it.');
    return null;
  }
  return key;
}

export function encryptCredential(plaintext) {
  const key = getMasterKey();
  if (!key) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set - required to store provider credentials. Generate one with `openssl rand -base64 32` (must match the SAME value configured in the saas-platform project).'
    );
  }
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([nonce, ciphertext, authTag]);
  return packed.toString('base64');
}

export function decryptCredential(encryptedValue) {
  const key = getMasterKey();
  if (!key) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set - cannot decrypt stored provider credentials.');
  }
  const packed = Buffer.from(encryptedValue, 'base64');
  const nonce = packed.subarray(0, NONCE_LENGTH);
  const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(NONCE_LENGTH, packed.length - AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// A provider credential is one opaque string in the shared schema (see
// Project 2's settings/telephony UI - one password-style input per
// provider). Telnyx needs only an API key, so the bare string IS the
// apiKey. Twilio needs two values (accountSid + authToken), so for Twilio
// that one string is expected to be a JSON object pasted in:
// {"accountSid":"AC...","authToken":"..."}. This helper normalizes both
// shapes into the {apiKey} / {accountSid, authToken} object each
// providers/*.js module already expects.
function parseProviderCredentialValue(provider, rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    parsed = null;
  }
  if (provider === 'twilio') {
    if (parsed && parsed.accountSid && parsed.authToken) return parsed;
    throw new Error(
      'Twilio credentials must be saved as JSON: {"accountSid":"AC...","authToken":"..."} - a bare string is not enough for Twilio (it needs two values).'
    );
  }
  if (provider === 'telnyx') {
    if (parsed && parsed.apiKey) return parsed;
    // Bare string is fine for Telnyx - it only needs one value.
    return { apiKey: rawValue };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// ---- Tenants ------------------------------------------------------------
export async function createTenant(name) {
  const id = newId();
  const { rows } = await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, $2) RETURNING *`,
    [id, name]
  );
  return rows[0];
}

export async function getTenant(tenantId) {
  const { rows } = await pool.query(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  return rows[0] || null;
}

export async function listTenants() {
  const { rows } = await pool.query(`SELECT * FROM tenants ORDER BY created_at DESC`);
  return rows;
}

// ---- Agents ---------------------------------------------------------------
// Field names match schema.prisma's Agent model exactly. Two fields this
// project's original (pre-integration) design had - opening_line_template,
// voice_provider/voice_model - are gone: greeting_message is the canonical
// name for the opening line (same {{placeholder}} templating, just renamed
// to match the shared contract), and voice_provider/voice_model turned out
// to be dead fields at runtime anyway (actual TTS provider selection reads
// the separate global ttsConfig, not per-agent settings) - folded into the
// single voice_id the shared schema defines.
export async function createAgent(tenantId, agent) {
  const id = newId();
  const { rows } = await pool.query(
    `INSERT INTO agents
      (id, tenant_id, name, description, system_prompt, voice_id, llm_model,
       is_enabled, greeting_message, closing_message, transfer_number,
       transfer_conditions, assigned_phone_number_id, knowledge_base_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      id, tenantId, agent.name, agent.description || null, agent.systemPrompt,
      agent.voiceId || null, agent.llmModel || null,
      agent.isEnabled ?? true, agent.greetingMessage || null, agent.closingMessage || null,
      agent.transferNumber || null, agent.transferConditions || [],
      agent.assignedPhoneNumberId || null, agent.knowledgeBaseId || null,
    ]
  );
  return rows[0];
}

export async function getAgent(agentId) {
  const { rows } = await pool.query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
  return rows[0] || null;
}

export async function listAgentsForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM agents WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows;
}

export async function updateAgent(agentId, fields) {
  // Accepts either snake_case (matching the DB columns directly, used by
  // this project's existing admin-panel routes) or a couple of legacy
  // camelCase/renamed keys for backward compatibility with call sites that
  // haven't been updated yet.
  const rename = { opening_line_template: 'greeting_message', openingLineTemplate: 'greeting_message' };
  const allowed = [
    'name', 'description', 'system_prompt', 'voice_id', 'llm_model', 'is_enabled',
    'greeting_message', 'closing_message', 'transfer_number', 'transfer_conditions',
    'assigned_phone_number_id', 'knowledge_base_id',
  ];
  const sets = [];
  const values = [];
  let i = 1;
  for (const [rawKey, value] of Object.entries(fields)) {
    const key = rename[rawKey] || rawKey;
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${i}`);
    values.push(value);
    i++;
  }
  if (sets.length === 0) return getAgent(agentId);
  values.push(agentId);
  const { rows } = await pool.query(
    `UPDATE agents SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ---- Phone numbers ----------------------------------------------------------
// Credentials are NOT stored on phone_numbers in the canonical schema -
// they live in the shared provider_credentials table, one row per
// (tenant, provider), owned by Project 2's telephony settings UI. A phone
// number just says which provider it's on; the credentials for that
// provider are looked up separately (see getProviderCredentials below).
export async function createPhoneNumber(tenantId, { number, provider, agentId }) {
  const id = newId();
  const { rows } = await pool.query(
    `INSERT INTO phone_numbers (id, tenant_id, provider, e164_number, assigned_agent_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [id, tenantId, provider, number, agentId || null]
  );
  return rows[0];
}

// Used by the single-tenant admin panel's Settings > Telephony save (the
// bootstrap "Default" tenant this project creates on first boot, see
// server.js) - lets the DB-backed lookup be populated even before Project
// 2's multi-tenant UI is what's driving it. Upserts on (tenant, e164Number)
// since there's no separate unique constraint on the number alone in the
// canonical schema.
export async function upsertPhoneNumber(tenantId, { number, provider, agentId }) {
  const existing = await pool.query(
    `SELECT id FROM phone_numbers WHERE tenant_id = $1 AND e164_number = $2`,
    [tenantId, number]
  );
  if (existing.rows[0]) {
    const { rows } = await pool.query(
      `UPDATE phone_numbers SET provider = $1, assigned_agent_id = $2 WHERE id = $3 RETURNING *`,
      [provider, agentId || null, existing.rows[0].id]
    );
    return rows[0];
  }
  return createPhoneNumber(tenantId, { number, provider, agentId });
}

// Credentials for a (tenant, provider) pair - the shared table Project 2's
// telephony settings UI writes to. Returns the parsed {apiKey} or
// {accountSid, authToken} shape providers/*.js expects, or null if the
// tenant hasn't connected that provider yet.
export async function getProviderCredentials(tenantId, provider) {
  const { rows } = await pool.query(
    `SELECT encrypted_value FROM provider_credentials WHERE tenant_id = $1 AND provider = $2`,
    [tenantId, provider]
  );
  if (!rows[0]) return null;
  const decrypted = decryptCredential(rows[0].encrypted_value);
  return parseProviderCredentialValue(provider, decrypted);
}

export async function saveProviderCredentials(tenantId, provider, credentialObjectOrString) {
  const raw = typeof credentialObjectOrString === 'string'
    ? credentialObjectOrString
    : JSON.stringify(credentialObjectOrString);
  const encryptedValue = encryptCredential(raw);
  const id = newId();
  await pool.query(
    `INSERT INTO provider_credentials (id, tenant_id, provider, encrypted_value, encryption_key_version)
     VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value`,
    [id, tenantId, provider, encryptedValue]
  );
}

// The one lookup both inbound routing ("which agent owns the number that
// was dialed") and outbound dialing ("which credentials do I dial from
// this number with") depend on.
export async function getPhoneNumberWithAgent(number) {
  const { rows } = await pool.query(
    `SELECT
       pn.id, pn.tenant_id, pn.e164_number, pn.provider,
       a.id AS agent_id, a.name AS agent_name, a.system_prompt, a.greeting_message,
       a.closing_message, a.voice_id, a.transfer_number, a.transfer_conditions,
       a.llm_model, a.knowledge_base_id
     FROM phone_numbers pn
     LEFT JOIN agents a ON a.id = pn.assigned_agent_id AND a.is_enabled = true
     WHERE pn.e164_number = $1`,
    [number]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const credentials = await getProviderCredentials(row.tenant_id, row.provider);
  return { ...row, provider_credentials: credentials };
}

export async function listPhoneNumbersForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM phone_numbers WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows;
}

// ---- Do-not-call, per tenant --------------------------------------------
export async function isOnDncList(tenantId, phoneNumber) {
  const { rows } = await pool.query(
    `SELECT 1 FROM dnc_numbers WHERE tenant_id = $1 AND phone_number = $2`,
    [tenantId, phoneNumber]
  );
  return rows.length > 0;
}

export async function addToDncList(tenantId, phoneNumber, reason = 'manual') {
  const id = newId();
  await pool.query(
    `INSERT INTO dnc_numbers (id, tenant_id, phone_number, reason)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, phone_number) DO NOTHING`,
    [id, tenantId, phoneNumber, reason]
  );
}

export async function listDncForTenant(tenantId) {
  const { rows } = await pool.query(
    `SELECT * FROM dnc_numbers WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

// ---- Calls ----------------------------------------------------------------
// Every call is attributed to a lead/campaign when the dial came from a
// campaign (see campaignRunner.js) - both columns are nullable for
// one-off/admin-panel calls that aren't tied to either.
export async function createCall(call) {
  const id = newId();
  const { rows } = await pool.query(
    `INSERT INTO calls
      (id, tenant_id, agent_id, phone_number_id, lead_id, campaign_id, provider,
       provider_call_id, direction, from_number, to_number, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (provider, provider_call_id) DO UPDATE SET status = EXCLUDED.status
     RETURNING *`,
    [
      id, call.tenantId, call.agentId || null, call.phoneNumberId || null,
      call.leadId || null, call.campaignId || null,
      call.provider, call.providerCallId, call.direction,
      call.fromNumber, call.toNumber, call.status || 'initiated',
    ]
  );
  return rows[0];
}

export async function updateCallByProviderId(provider, providerCallId, fields) {
  const allowed = ['status', 'answered_by', 'outcome', 'duration_seconds', 'recording_url', 'ended_at', 'transcript_ready', 'transfer_triggered', 'transfer_reason'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${i}`);
    values.push(value);
    i++;
  }
  if (sets.length === 0) return null;
  values.push(provider, providerCallId);
  const { rows } = await pool.query(
    `UPDATE calls SET ${sets.join(', ')} WHERE provider = $${i} AND provider_call_id = $${i + 1} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// Transcript is a single TEXT blob in the canonical schema (Project 2
// renders it directly in a <pre> block), not a JSONB array of turns. This
// project still builds up the conversation turn-by-turn internally
// (CallSession.history in server.js, entries shaped {role: 'user'|
// 'assistant', content: text} - 'user' is the caller, 'assistant' is the
// AI agent) for its own barge-in-safe incremental logic - flattened into
// "Lead: ...\nAgent: ...\n" lines for the shared `transcript` column right
// when the call ends, rather than on every turn.
function flattenTranscript(history) {
  if (!history) return null;
  if (typeof history === 'string') return history;
  return history
    .map((turn) => `${turn.role === 'assistant' ? 'Agent' : 'Lead'}: ${turn.content}`)
    .join('\n');
}

// Call this once the call is fully over - flips transcript_ready, which is
// what triggers this project's call.ended webhook to the intelligence
// service (see notifyCallEnded in webhooks.js).
export async function markCallEnded(provider, providerCallId, { durationSeconds, outcome, recordingUrl, transcript } = {}) {
  const { rows } = await pool.query(
    `UPDATE calls
     SET status = 'completed', ended_at = now(), transcript_ready = true,
         duration_seconds = COALESCE($3, duration_seconds),
         outcome = COALESCE($4, outcome),
         recording_url = COALESCE($5, recording_url),
         transcript = COALESCE($6, transcript)
     WHERE provider = $1 AND provider_call_id = $2
     RETURNING *`,
    [provider, providerCallId, durationSeconds ?? null, outcome ?? null, recordingUrl ?? null, flattenTranscript(transcript)]
  );
  return rows[0] || null;
}

export async function getCallByProviderId(provider, providerCallId) {
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE provider = $1 AND provider_call_id = $2`,
    [provider, providerCallId]
  );
  return rows[0] || null;
}

export async function listCallsForTenant(tenantId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit]
  );
  return rows;
}

export async function listCallsForNumber(tenantId, toNumber) {
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE tenant_id = $1 AND to_number = $2 ORDER BY created_at DESC`,
    [tenantId, toNumber]
  );
  return rows;
}

export async function getAnalyticsSummary(tenantId) {
  const totals = await pool.query(
    `SELECT
       count(*) AS total_calls_initiated,
       count(*) FILTER (WHERE transcript_ready) AS total_completed,
       count(*) FILTER (WHERE answered_by = 'machine') AS total_voicemails
     FROM calls WHERE tenant_id = $1`,
    [tenantId]
  );
  const outcomes = await pool.query(
    `SELECT coalesce(outcome, 'unclear') AS outcome, count(*) AS n
     FROM calls WHERE tenant_id = $1 AND transcript_ready
     GROUP BY 1`,
    [tenantId]
  );
  const perDay = await pool.query(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, count(*) AS n
     FROM calls
     WHERE tenant_id = $1 AND created_at >= now() - interval '14 days'
     GROUP BY 1`,
    [tenantId]
  );
  const outcomeCounts = {};
  for (const row of outcomes.rows) outcomeCounts[row.outcome] = Number(row.n);
  const callsPerDay = {};
  for (const row of perDay.rows) callsPerDay[row.day] = Number(row.n);
  const t = totals.rows[0];
  return {
    totalCallsInitiated: Number(t.total_calls_initiated),
    totalCompleted: Number(t.total_completed),
    totalVoicemails: Number(t.total_voicemails),
    outcomeCounts,
    callsPerDay,
  };
}

// ---- Leads & campaigns (read-mostly; owned by Project 2) -------------------
// This project reads these to drive the multi-tenant campaign dialer (see
// campaignRunner.js) and writes back only the narrow progress fields
// (dialed_count/skipped_count/status/started_at/finished_at) that were
// previously just stubbed client-side in Project 2's campaigns.ts.
export async function getCampaign(campaignId) {
  const { rows } = await pool.query(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
  return rows[0] || null;
}

export async function getLeadsByIds(tenantId, leadIds) {
  if (!leadIds || leadIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [tenantId, leadIds]
  );
  return rows;
}

export async function updateCampaignProgress(campaignId, fields) {
  const allowed = ['status', 'dialed_count', 'skipped_count', 'started_at', 'finished_at'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${i}`);
    values.push(value);
    i++;
  }
  if (sets.length === 0) return null;
  values.push(campaignId);
  const { rows } = await pool.query(
    `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

// ---- Knowledge base (chunks owned by this project; sources by Project 2) --
export async function getKnowledgeSource(sourceId) {
  const { rows } = await pool.query(`SELECT * FROM knowledge_sources WHERE id = $1`, [sourceId]);
  return rows[0] || null;
}

export async function deleteKnowledgeChunksForSource(sourceId) {
  await pool.query(`DELETE FROM knowledge_chunks WHERE source_id = $1`, [sourceId]);
}

export async function insertKnowledgeChunk({ sourceId, tenantId, agentId, chunkText, embedding }) {
  const id = newId();
  await pool.query(
    `INSERT INTO knowledge_chunks (id, source_id, tenant_id, agent_id, chunk_text, embedding)
     VALUES ($1,$2,$3,$4,$5,$6::vector)`,
    [id, sourceId, tenantId, agentId, chunkText, `[${embedding.join(',')}]`]
  );
}

// Cosine-similarity top-k lookup used during a live call to retrieve
// relevant knowledge for an agent's response.
export async function searchKnowledgeChunks(agentId, queryEmbedding, limit = 4) {
  const { rows } = await pool.query(
    `SELECT chunk_text, 1 - (embedding <=> $2::vector) AS similarity
     FROM knowledge_chunks
     WHERE agent_id = $1 AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [agentId, `[${queryEmbedding.join(',')}]`, limit]
  );
  return rows;
}
