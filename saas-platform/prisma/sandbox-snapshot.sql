-- HAND-DERIVED SANDBOX SNAPSHOT — NOT the source of truth.
--
-- prisma/schema.prisma is canonical. This file exists only because Prisma's
-- CLI (`prisma generate` / `db push` / `migrate`) needs to download engine
-- binaries from binaries.prisma.sh, which was not reachable from the
-- sandbox this integration was built in. In your own environment, ignore
-- this file and run the real thing:
--
--   psql "$DATABASE_URL" -f prisma/sql/enable-pgvector.sql
--   npm run db:push
--
-- This file hand-translates schema.prisma's Postgres mapping (String->TEXT,
-- id String @default(cuid()) -> TEXT PRIMARY KEY with NO db-level default
-- since Prisma computes cuids client-side, DateTime->TIMESTAMP(3), Json->
-- JSONB, String[]->TEXT[]) for the subset of tables Projects 1 and 3 read
-- or write, so the integration could actually be proven against a real
-- Postgres instance. It deliberately excludes users/invites/
-- password_reset_tokens/audit_logs/platform_settings, which only Project 2
-- touches and which schema.prisma already owns unambiguously.
--
-- If you ever need to run without the Prisma CLI for real (e.g. a
-- restricted network at deploy time too), this file is a legitimate
-- fallback — keep it in sync with schema.prisma by hand if so.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'trial',
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phone_numbers (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  e164_number        TEXT NOT NULL,
  assigned_agent_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_tenant ON phone_numbers(tenant_id);

CREATE TABLE IF NOT EXISTS agents (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  description              TEXT,
  system_prompt            TEXT NOT NULL,
  voice_id                 TEXT,
  llm_model                TEXT,
  is_enabled               BOOLEAN NOT NULL DEFAULT true,
  greeting_message         TEXT,
  closing_message          TEXT,
  transfer_number          TEXT,
  transfer_conditions      TEXT[] NOT NULL DEFAULT '{}',
  assigned_phone_number_id TEXT REFERENCES phone_numbers(id),
  knowledge_base_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_agents_tenant ON agents(tenant_id);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  raw_content TEXT,
  source_url  TEXT,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources(tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_agent ON knowledge_sources(agent_id);

-- pgvector extension is required for the embedding column. If unavailable,
-- comment out the `embedding` line - chunk text/lookup still works, just
-- without similarity search, until pgvector is installed.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding  vector(384)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider               TEXT NOT NULL,
  encrypted_value        TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  created_at             TIMESTAMP(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_tenant ON provider_credentials(tenant_id);

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone         TEXT,
  email         TEXT,
  name          TEXT,
  company       TEXT,
  custom_fields JSONB,
  status        TEXT NOT NULL DEFAULT 'new',
  tags          TEXT[] NOT NULL DEFAULT '{}',
  notes         JSONB[] NOT NULL DEFAULT '{}',
  source        TEXT,
  campaign_id   TEXT,
  qualification JSONB,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  phone_number_id TEXT NOT NULL REFERENCES phone_numbers(id),
  status          TEXT NOT NULL DEFAULT 'draft',
  schedule        JSONB,
  retry_config    JSONB,
  lead_ids        TEXT[] NOT NULL DEFAULT '{}',
  dialed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMP(3),
  finished_at     TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);

ALTER TABLE leads ADD CONSTRAINT fk_leads_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

CREATE TABLE IF NOT EXISTS calls (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id             TEXT REFERENCES leads(id),
  campaign_id         TEXT REFERENCES campaigns(id),
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  phone_number_id     TEXT REFERENCES phone_numbers(id),
  direction           TEXT NOT NULL,
  status              TEXT NOT NULL,
  provider            TEXT,
  provider_call_id    TEXT,
  from_number         TEXT,
  to_number           TEXT,
  answered_by         TEXT,
  transcript_ready    BOOLEAN NOT NULL DEFAULT false,
  started_at          TIMESTAMP(3),
  ended_at            TIMESTAMP(3),
  duration_seconds    INTEGER,
  recording_url       TEXT,
  transcript          TEXT,
  summary             TEXT,
  outcome             TEXT,
  sentiment           TEXT,
  extracted_info      JSONB,
  transfer_triggered  BOOLEAN NOT NULL DEFAULT false,
  transfer_reason     TEXT,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);
CREATE INDEX IF NOT EXISTS idx_calls_tenant ON calls(tenant_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_calls_campaign ON calls(campaign_id);

CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id           TEXT NOT NULL REFERENCES leads(id),
  call_id           TEXT REFERENCES calls(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  scheduled_time    TIMESTAMP(3) NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled',
  calendar_event_id TEXT,
  confirmation_sent BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_appointments_tenant ON appointments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_appointments_lead ON appointments(lead_id);

CREATE TABLE IF NOT EXISTS dnc_numbers (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT 'manual',
  created_at   TIMESTAMP(3) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);
CREATE INDEX IF NOT EXISTS idx_dnc_tenant ON dnc_numbers(tenant_id);

-- processed_call_events: Project 3's own idempotency table (not part of the
-- shared contract - internal to that service, kept out of schema.prisma
-- deliberately since Project 2 never needs to query it).
CREATE TABLE IF NOT EXISTS processed_call_events (
  event_id TEXT PRIMARY KEY,
  call_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- tenant_calendar_config: Project 3's own read-only-from-Project-2 config
-- table, documented in Project 3's build notes. Also not in schema.prisma
-- since Project 2 doesn't manage it yet (flagged as a follow-up).
CREATE TABLE IF NOT EXISTS tenant_calendar_config (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  provider TEXT NOT NULL DEFAULT 'mock',
  calendar_id TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  slot_duration_minutes INTEGER NOT NULL DEFAULT 30,
  business_hours JSONB DEFAULT '{"start":"09:00","end":"17:00","days":[1,2,3,4,5]}'::jsonb
);
