require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { createPool } = require('./pool');

async function migrate() {
  const pool = createPool();
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const version of ['001_create_slips', '002_create_slip_edit_sessions', '003_add_recipient_and_category', '004_add_sender_and_transaction_type', '005_add_recipient_name_parts', '006_add_ai_model', '007_remove_ai_transaction_categories', '008_recipient_company_and_bank', '009_split_transfer_banks', '010_add_slip_image']) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (existing.rowCount === 0) {
        const migrationSql = await fs.readFile(path.join(__dirname, `../../migrations/${version}.sql`), 'utf8');
        await client.query(migrationSql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        console.log(`Applied migration ${version}`);
      } else {
        console.log(`Migration ${version} is already applied`);
      }
    }
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (client && transactionStarted) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error('Database migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
