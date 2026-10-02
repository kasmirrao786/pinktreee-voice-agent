-- Run this once against your Postgres database BEFORE `prisma db push`,
-- so the `vector(384)` column on knowledge_chunks can be created.
-- Railway Postgres, Supabase, and most managed Postgres providers support
-- the pgvector extension; enable it in your provider's dashboard if this
-- CREATE EXTENSION statement is rejected for permission reasons.

CREATE EXTENSION IF NOT EXISTS vector;
