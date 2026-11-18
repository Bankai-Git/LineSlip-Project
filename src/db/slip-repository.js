const { normalizePendingSlip, normalizeEditedSlip } = require('./normalize-pending-slip');

const SLIP_COLUMNS = `
  id, line_user_id, message_id, webhook_event_id, reference_no,
  amount::text, transaction_date::text, transaction_time::text, status,
  ocr_confidence, received_at, created_at, confirmed_at,
  sender_prefix, sender_first_name, sender_last_name, transaction_type,
  recipient_prefix, recipient_first_name, recipient_last_name, recipient_company_name, sender_bank_name, recipient_bank_name
  , image_path, image_mime_type
`;

function createSlipRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required');

  async function createPendingSlip(parserResult) {
    const slip = normalizePendingSlip(parserResult);
    const client = await pool.connect();
    let inserted;
    try {
      await client.query('BEGIN');
      // Serialize app inserts so a deleted low ID is reliably reused without races.
      await client.query('SELECT pg_advisory_xact_lock(1886221356, 1)');
      const allocatedId = await client.query(`
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM slips WHERE id = 1) THEN 1
          ELSE COALESCE(
            (SELECT current_row.id + 1
             FROM slips AS current_row
             WHERE NOT EXISTS (SELECT 1 FROM slips AS next_row WHERE next_row.id = current_row.id + 1)
             ORDER BY current_row.id
             LIMIT 1),
            (SELECT COALESCE(MAX(id), 0) + 1 FROM slips)
          )
        END::bigint AS id
      `);
      inserted = await client.query(
        `INSERT INTO slips (
          id, line_user_id, message_id, webhook_event_id, reference_no, amount,
          transaction_date, transaction_time, status, ocr_confidence, received_at,
          sender_prefix, sender_first_name, sender_last_name, transaction_type,
          recipient_prefix, recipient_first_name, recipient_last_name, recipient_company_name, sender_bank_name, recipient_bank_name,
          image_path, image_mime_type
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        ON CONFLICT DO NOTHING
        RETURNING ${SLIP_COLUMNS}`,
        [
          allocatedId.rows[0].id, slip.lineUserId, slip.messageId, slip.webhookEventId, slip.referenceNo,
          slip.amount, slip.transactionDate, slip.transactionTime, slip.ocrConfidence, slip.receivedAt,
          slip.senderPrefix, slip.senderFirstName, slip.senderLastName, slip.transactionType,
          slip.recipientPrefix, slip.recipientFirstName, slip.recipientLastName,
          slip.recipientCompanyName, slip.senderBankName, slip.recipientBankName,
          parserResult.image?.path || null, parserResult.image?.mimeType || null,
        ],
      );
      if (inserted.rowCount === 1) await client.query('COMMIT');
      else await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (inserted.rowCount === 1) return { status: 'created', slip: inserted.rows[0] };

    const existingResult = await pool.query(
      `SELECT ${SLIP_COLUMNS}
       FROM slips
       WHERE line_user_id = $1
         AND (message_id = $2 OR reference_no = $3)
       ORDER BY CASE WHEN message_id = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [slip.lineUserId, slip.messageId, slip.referenceNo],
    );
    if (existingResult.rowCount === 1) {
      const existing = existingResult.rows[0];
      return {
        status: 'duplicate',
        reason: existing.message_id === slip.messageId ? 'message_id' : 'reference_no',
        slip: existing,
      };
    }

    // A webhook event ID can collide globally even if the caller supplies a different user ID.
    // Return no other user's row or identifying data.
    return { status: 'duplicate', reason: 'webhook_event_id', slip: null };
  }

  async function confirmPendingSlip({ id, lineUserId }) {
    if (!/^[1-9]\d*$/.test(String(id))) throw new TypeError('A valid slip ID is required');
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new TypeError('LINE userId is required');

    const confirmed = await pool.query(
      `UPDATE slips
       SET status = 'confirmed', confirmed_at = NOW()
       WHERE id = $1 AND line_user_id = $2 AND status = 'pending'
       RETURNING ${SLIP_COLUMNS}`,
      [String(id), lineUserId.trim()],
    );
    if (confirmed.rowCount === 1) return { status: 'confirmed', slip: confirmed.rows[0] };

    const existing = await pool.query(
      `SELECT id, status FROM slips WHERE id = $1 AND line_user_id = $2`,
      [String(id), lineUserId.trim()],
    );
    if (existing.rowCount === 0) return { status: 'not_found', slip: null };
    return { status: 'already_confirmed', slip: existing.rows[0] };
  }

  async function startPendingSlipEdit({ id, lineUserId }) {
    if (!/^[1-9]\d*$/.test(String(id))) throw new TypeError('A valid slip ID is required');
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new TypeError('LINE userId is required');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT ${SLIP_COLUMNS} FROM slips
         WHERE id = $1 AND line_user_id = $2 FOR UPDATE`,
        [String(id), lineUserId.trim()],
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return { status: 'not_found', slip: null };
      }
      const slip = result.rows[0];
      if (slip.status !== 'pending') {
        await client.query('ROLLBACK');
        return { status: 'already_confirmed', slip };
      }
      await client.query(
        `INSERT INTO slip_edit_sessions (line_user_id, slip_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '15 minutes')
         ON CONFLICT (line_user_id) DO UPDATE
         SET slip_id = EXCLUDED.slip_id, requested_at = NOW(), expires_at = EXCLUDED.expires_at`,
        [lineUserId.trim(), String(id)],
      );
      await client.query('COMMIT');
      return { status: 'editing', slip };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function applyPendingSlipEdit(input) {
    const { lineUserId } = input;
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new TypeError('LINE userId is required');
    const edited = normalizeEditedSlip(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query(
        `SELECT s.id, s.status
         FROM slip_edit_sessions AS e JOIN slips AS s ON s.id = e.slip_id
         WHERE e.line_user_id = $1 AND e.expires_at > NOW()
         FOR UPDATE OF e, s`,
        [lineUserId.trim()],
      );
      if (session.rowCount === 0) {
        await client.query('ROLLBACK');
        return { status: 'no_active_edit', slip: null };
      }
      if (session.rows[0].status !== 'pending') {
        await client.query('DELETE FROM slip_edit_sessions WHERE line_user_id = $1', [lineUserId.trim()]);
        await client.query('COMMIT');
        return { status: 'already_confirmed', slip: null };
      }

      const updated = await client.query(
        `UPDATE slips SET reference_no = $1, amount = $2, transaction_date = $3,
           transaction_time = $4, transaction_type = COALESCE($5, transaction_type),
           sender_prefix = CASE WHEN $7::boolean THEN $6 ELSE sender_prefix END,
           sender_first_name = CASE WHEN $9::boolean THEN $8 ELSE sender_first_name END,
           sender_last_name = CASE WHEN $11::boolean THEN $10 ELSE sender_last_name END,
           recipient_prefix = CASE WHEN $5 = 'bill_payment' THEN NULL WHEN $13::boolean THEN $12 ELSE recipient_prefix END,
           recipient_first_name = CASE WHEN $5 = 'bill_payment' THEN NULL WHEN $15::boolean THEN $14 ELSE recipient_first_name END,
           recipient_last_name = CASE WHEN $5 = 'bill_payment' THEN NULL WHEN $17::boolean THEN $16 ELSE recipient_last_name END,
           recipient_company_name = CASE WHEN $5 IS NOT NULL AND $5 <> 'bill_payment' THEN NULL WHEN $19::boolean THEN $18 ELSE recipient_company_name END
         WHERE id = $20 AND line_user_id = $21 AND status = 'pending'
         RETURNING ${SLIP_COLUMNS}`,
        [
          edited.referenceNo, edited.amount, edited.transactionDate, edited.transactionTime,
          edited.transactionType, edited.senderPrefix, edited.senderPrefixProvided,
          edited.senderFirstName, edited.senderFirstNameProvided,
          edited.senderLastName, edited.senderLastNameProvided,
          edited.recipientPrefix, edited.recipientPrefixProvided,
          edited.recipientFirstName, edited.recipientFirstNameProvided,
          edited.recipientLastName, edited.recipientLastNameProvided,
          edited.recipientCompanyName, edited.recipientCompanyNameProvided,
          session.rows[0].id, lineUserId.trim(),
        ],
      );
      await client.query('DELETE FROM slip_edit_sessions WHERE line_user_id = $1', [lineUserId.trim()]);
      await client.query('COMMIT');
      return { status: 'updated', slip: updated.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505') return { status: 'duplicate_reference', slip: null };
      throw error;
    } finally {
      client.release();
    }
  }

  async function getPeriodSummary({ lineUserId, startDate, endDate }) {
    const totals = await pool.query(
      `SELECT COUNT(*)::int AS transaction_count, COALESCE(SUM(amount), 0)::text AS total_amount
       FROM slips
       WHERE line_user_id = $1 AND status = 'confirmed' AND transaction_date >= $2::date AND transaction_date < $3::date`,
      [lineUserId, startDate, endDate],
    );
    const rows = await pool.query(
      `SELECT id::text, amount::text, transaction_date::text, transaction_time::text,
              transaction_type
       FROM slips
       WHERE line_user_id = $1 AND status = 'confirmed' AND transaction_date >= $2::date AND transaction_date < $3::date
       ORDER BY transaction_date, transaction_time NULLS LAST, id`,
      [lineUserId, startDate, endDate],
    );
    const transactionTypes = await pool.query(
      `SELECT transaction_type, COUNT(*)::int AS transaction_count,
              COALESCE(SUM(amount), 0)::text AS total_amount
       FROM slips
       WHERE line_user_id = $1 AND status = 'confirmed' AND transaction_date >= $2::date AND transaction_date < $3::date
       GROUP BY transaction_type
       ORDER BY transaction_type`,
      [lineUserId, startDate, endDate],
    );
    return {
      startDate,
      endDate,
      transactionCount: totals.rows[0].transaction_count,
      totalAmount: totals.rows[0].total_amount,
      transactions: rows.rows,
      transactionTypes: transactionTypes.rows,
    };
  }

  async function getDailySummary({ lineUserId, date }) {
    const endDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return { ...(await getPeriodSummary({ lineUserId, startDate: date, endDate })), date };
  }

  async function getLatestConfirmedDate({ lineUserId }) {
    const result = await pool.query(
      `SELECT MAX(transaction_date)::text AS date
       FROM slips
       WHERE line_user_id = $1 AND status = 'confirmed'`,
      [lineUserId],
    );
    return result.rows[0]?.date || null;
  }

  async function listDashboardSlips({ lineUserId, date = null, status = null, limit = 50, offset = 0 }) {
    const where = ['line_user_id = $1'];
    const values = [lineUserId];
    if (date) {
      values.push(date);
      where.push(`transaction_date = $${values.length}::date`);
    }
    if (status) {
      values.push(status);
      where.push(`status = $${values.length}`);
    }
    const predicate = where.join(' AND ');
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM slips WHERE ${predicate}`,
      values,
    );
    const pageValues = [...values, limit, offset];
    const rowsResult = await pool.query(
      `SELECT id::text, line_user_id, message_id, webhook_event_id, reference_no,
              amount::text, transaction_date::text, transaction_time::text, status,
              ocr_confidence::text, received_at, created_at, confirmed_at,
              sender_prefix, sender_first_name,
              sender_last_name, transaction_type, recipient_prefix, recipient_first_name,
              recipient_last_name, recipient_company_name, sender_bank_name, recipient_bank_name,
              image_path, image_mime_type
       FROM slips
       WHERE ${predicate}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      pageValues,
    );
    return { total: countResult.rows[0].total, rows: rowsResult.rows };
  }

  async function deleteDashboardSlip({ id, lineUserId }) {
    if (!/^[1-9]\d*$/.test(String(id))) throw new TypeError('A valid slip ID is required');
    if (typeof lineUserId !== 'string' || !lineUserId.trim()) throw new TypeError('LINE userId is required');
    const result = await pool.query(
      `DELETE FROM slips WHERE id = $1 AND line_user_id = $2 RETURNING id::text`,
      [String(id), lineUserId.trim()],
    );
    return result.rowCount === 1;
  }

  async function getSlipImage({ id, lineUserId }) {
    const result = await pool.query(
      `SELECT image_path, image_mime_type FROM slips WHERE id = $1 AND line_user_id = $2`,
      [String(id), lineUserId],
    );
    return result.rows[0] || null;
  }

  async function listUsersWithConfirmedSlips(date) {
    const result = await pool.query(
      `SELECT DISTINCT line_user_id FROM slips
       WHERE status = 'confirmed' AND transaction_date = $1::date
       ORDER BY line_user_id`,
      [date],
    );
    return result.rows.map((row) => row.line_user_id);
  }

  return {
    createPendingSlip,
    confirmPendingSlip,
    startPendingSlipEdit,
    applyPendingSlipEdit,
    getDailySummary,
    getPeriodSummary,
    getLatestConfirmedDate,
    listDashboardSlips,
    deleteDashboardSlip,
    getSlipImage,
    listUsersWithConfirmedSlips,
  };
}

module.exports = { createSlipRepository };
