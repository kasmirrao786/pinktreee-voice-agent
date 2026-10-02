// Run this by hand to set up (or update) the schema:
//   node db/migrate.js
//
// Deliberately separate from server.js's own startup - Phase 1 of the
// multi-tenant migration is just "does the schema apply cleanly against a
// real Postgres instance", not yet "the running server depends on it".
import 'dotenv/config';
import { migrate, pool, dbEnabled } from './index.js';

if (!dbEnabled) {
  console.error('DATABASE_URL is not set - nothing to migrate. Set it in .env first.');
  process.exit(1);
}

try {
  await migrate();
  console.log('Migration complete.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
