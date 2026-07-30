const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requirePermission } = require('../middleware/access');
const { resolveAccount, insertPendingRow } = require('../services/messageSender');
const { enqueueSend } = require('../queue/sendQueue');
const { buildTemplateComponents, resolveTemplateText } = require('../services/templateComponents');

// Load per-recipient context (name + custom_fields + tags) so field-mapped
// template variables (custom_fields.X / category_tag.X) resolve to each
// contact's real value. Keyed by digits-only phone number.
async function loadContactContext(numbers) {
  const map = new Map();
  const list = [...new Set((numbers || []).map(n => String(n).replace(/\D/g, '')).filter(Boolean))];
  if (list.length === 0) return map;
  const { rows } = await pool.query(
    `SELECT regexp_replace(contact_number, '\\D', '', 'g') AS num, name, custom_fields, tags
       FROM coexistence.contacts
      WHERE regexp_replace(contact_number, '\\D', '', 'g') = ANY($1::text[])`,
    [list]
  );
  for (const r of rows) { if (!map.has(r.num)) map.set(r.num, r); }
  return map;
}

// Resolve the media id for media-type broadcasts AND for template broadcasts
// whose template has a media header (IMAGE/VIDEO/DOCUMENT) — both pull from
// broadcast.media_library_id, falling back to the template's own header image
// (message_templates.header_media_library_id) when the campaign didn't pick a
// separate asset. Shared by /send, /test and the per-recipient /retry route so
// the three don't drift out of sync.
async function resolveHeaderMedia({ broadcast, template, account }) {
  const tplHeaderType = template ? String(template.header_type || '').toUpperCase() : '';
  const needsHeaderMedia = broadcast.message_type === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(tplHeaderType);
  const headerMediaLibId = broadcast.media_library_id || (template && template.header_media_library_id) || null;
  if (!((['image', 'video', 'audio', 'document'].includes(broadcast.message_type) || needsHeaderMedia) && headerMediaLibId)) {
    return null;
  }
  const { syncMediaToAccount } = require('./mediaLibrary');
  const { rows: mRows } = await pool.query(
    `SELECT * FROM coexistence.media_library WHERE id = $1 AND deleted_at IS NULL`,
    [headerMediaLibId]
  );
  if (!mRows.length) return null;
  const media = mRows[0];
  const { rows: sRows } = await pool.query(
    `SELECT * FROM coexistence.media_meta_sync WHERE media_id = $1 AND account_id = $2`,
    [media.id, account.id]
  );
  let sync = sRows[0];
  const needsSync = !sync || sync.status !== 'synced' || !sync.meta_media_id || (sync.expires_at && new Date(sync.expires_at) <= new Date());
  if (needsSync) {
    sync = await syncMediaToAccount(media.id, account.id);
    sync = { meta_media_id: sync.metaMediaId, expires_at: sync.expiresAt, status: sync.status };
  }
  return sync.meta_media_id;
}

// Load a broadcast + its joined template, in the shape /send, /test and /retry
// all need (template columns t_-prefixed to disambiguate from the broadcast's
// own columns of the same name).
async function loadBroadcastWithTemplate(id) {
  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.id AS t_id, t.name AS t_name, t.language AS t_language, t.body AS t_body,
            t.header_type AS t_header_type, t.header_text AS t_header_text, t.footer AS t_footer, t.buttons AS t_buttons, t.samples AS t_samples,
            t.header_media_library_id AS t_header_media_library_id
       FROM coexistence.broadcasts b
       LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
      WHERE b.id = $1`,
    [id]
  );
  if (bRows.length === 0) return null;
  const broadcast = bRows[0];
  const template = broadcast.message_type === 'template'
    ? { id: broadcast.t_id, name: broadcast.t_name, language: broadcast.t_language, body: broadcast.t_body,
        header_type: broadcast.t_header_type, header_text: broadcast.t_header_text, footer: broadcast.t_footer, buttons: broadcast.t_buttons, samples: broadcast.t_samples,
        header_media_library_id: broadcast.t_header_media_library_id }
    : null;
  return { broadcast, template };
}

async function enqueueBroadcastRecipient({ broadcast, template, account, recipient, broadcastLogId, resolvedMediaId }) {
  const msgType = broadcast.message_type || 'template';

  // ── Template ──────────────────────────────────────────────────────────
  if (msgType === 'template') {
    // resolvedMediaId doubles as the header image for media-header templates.
    const components = buildTemplateComponents({
      template,
      values: broadcast.variable_mapping,
      headerMediaId: resolvedMediaId,
      recipient,
    });
    // Store the RESOLVED body ({{1}} → the recipient's real value) so the Chats
    // view shows the actual message, exactly like WhatsApp — not raw {{1}}.
    const resolvedBody = resolveTemplateText(
      template.body, broadcast.variable_mapping, template.samples, recipient,
    );
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'template',
      messageBody: resolvedBody || `Template: ${template.name}`,
      templateMeta: {
        header_type: template.header_type || 'NONE',
        header_text: template.header_text || null,
        // Stable pointer to the header image so the Chats bubble renders the
        // real picture instead of a grey "Image header" placeholder. Falls back
        // to the template's own header image when the campaign didn't pick one.
        header_media_library_id: broadcast.media_library_id || template.header_media_library_id || null,
        footer: template.footer || null,
        buttons: Array.isArray(template.buttons) ? template.buttons : (template.buttons || []),
      },
    });
    await enqueueSend({
      kind: 'template',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        name: template.name,
        languageCode: template.language || 'en',
        components,
      },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Text ──────────────────────────────────────────────────────────────
  if (msgType === 'text') {
    const body = (broadcast.body || '').replace(/\{\{contact\.name\}\}/g, recipient.name || '').replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'text',
      messageBody: body,
    });
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { body },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Link ──────────────────────────────────────────────────────────────
  if (msgType === 'link') {
    const body = (broadcast.url || '').replace(/\{\{contact\.name\}\}/g, recipient.name || '').replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: 'text',
      messageBody: body,
    });
    await enqueueSend({
      kind: 'text',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: { body, previewUrl: true },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  // ── Media (image / video / audio / document) ──────────────────────────
  if (['image', 'video', 'audio', 'document'].includes(msgType)) {
    const caption = (broadcast.caption || '')
      .replace(/\{\{contact\.name\}\}/g, recipient.name || '')
      .replace(/\{\{contact\.number\}\}/g, recipient.contact_number || '');
    const localId = await insertPendingRow({
      account,
      toNumber: recipient.contact_number,
      messageType: msgType,
      messageBody: caption || `${msgType} message`,
    });
    await enqueueSend({
      kind: 'media',
      accountId: account.id,
      to: String(recipient.contact_number).replace(/\D/g, ''),
      localMessageId: localId,
      payload: {
        type: msgType,
        mediaId: resolvedMediaId || null,
        link: resolvedMediaId ? null : (broadcast.url || null),
        caption: caption || undefined,
      },
      originRef: broadcastLogId ? { kind: 'broadcast_log', id: broadcastLogId } : undefined,
    });
    return;
  }

  throw new Error(`Unsupported broadcast message_type: ${msgType}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getBroadcastWithLogs(id) {
  const { rows: bRows } = await pool.query(
    `SELECT b.*, t.name AS template_name, t.category AS template_category,
            t.language AS template_language, t.header_type, t.header_text,
            t.media_handle, t.body AS template_body, t.footer AS template_footer,
            t.buttons AS template_buttons, t.samples AS template_samples,
            t.security_recommendation, t.code_expiry_minutes
     FROM coexistence.broadcasts b
     LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
     WHERE b.id = $1`,
    [id]
  );
  if (bRows.length === 0) return null;

  // Aggregate BROADCAST logs into a single summary entry;
  // keep TEST logs as individual rows.
  const { rows: broadcastAgg } = await pool.query(
    `SELECT
       COUNT(*)::int AS recipient_count,
       MAX(sent_at) AS sent_at,
       CASE
         WHEN COUNT(*) FILTER (WHERE status = 'PENDING') > 0 THEN 'PENDING'
         WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0
          AND COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) = 0 THEN 'failed'
         WHEN COUNT(*) FILTER (WHERE status = 'failed') > 0 THEN 'sent'
         WHEN COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) > 0 THEN 'sent'
         ELSE MAX(status)
       END AS status,
       ARRAY_AGG(DISTINCT error_message) FILTER (WHERE error_message IS NOT NULL) AS errors
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'BROADCAST'`,
    [id]
  );

  const { rows: testLogs } = await pool.query(
    `SELECT id, action, sent_to, status, sent_at, wa_message_id, error_message
     FROM coexistence.broadcast_logs
     WHERE broadcast_id = $1 AND action = 'TEST'
     ORDER BY sent_at DESC`,
    [id]
  );

  // Cumulative funnel: a message that was read passed through delivered & sent
  // first. Counting only the *current* status (exclusive buckets) makes a fully
  // delivered broadcast look like "0 sent / 0 delivered / 2 read" — which is
  // semantically correct but confusing in a Delivery Summary. Users expect:
  //   sent      = ever-sent (sent OR delivered OR read)
  //   delivered = ever-delivered (delivered OR read)
  //   read      = read (terminal)
  const { rows: rollup } = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE bl.status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE bl.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE ch.status IN ('sent','delivered','read'))::int AS sent,
        COUNT(*) FILTER (WHERE ch.status IN ('delivered','read'))::int AS delivered,
        COUNT(*) FILTER (WHERE ch.status = 'read')::int AS read,
        MIN(bl.sent_at) AS first_sent_at
       FROM coexistence.broadcast_logs bl
       LEFT JOIN coexistence.chat_history ch ON ch.message_id = bl.wa_message_id
      WHERE bl.broadcast_id = $1 AND bl.action = 'BROADCAST'`,
    [id]
  );

  // "Replied" = the recipient sent an inbound message back after we messaged
  // them. Deliberately a SEPARATE query joining two pre-aggregated sets rather
  // than an EXISTS inside COUNT(...) FILTER: the latter can't be pulled up into
  // a semi-join, so it re-scans chat_history once per recipient — and this
  // endpoint is polled every 4s while a campaign is open. This form scans the
  // inbound side once, bounded to messages newer than the campaign's first send.
  const { rows: repliedRows } = await pool.query(
    `WITH logs AS (
       SELECT regexp_replace(sent_to, '\\D', '', 'g') AS num, MIN(sent_at) AS sent_at
         FROM coexistence.broadcast_logs
        WHERE broadcast_id = $1 AND action = 'BROADCAST' AND sent_at IS NOT NULL
        GROUP BY 1
     ),
     inbound AS (
       SELECT regexp_replace(ch.contact_number, '\\D', '', 'g') AS num, MAX(ch.timestamp) AS last_in
         FROM coexistence.chat_history ch
        WHERE ch.direction = 'incoming'
          AND regexp_replace(ch.wa_number, '\\D', '', 'g') = regexp_replace($2::text, '\\D', '', 'g')
          AND ch.timestamp > (SELECT MIN(sent_at) FROM logs)
        GROUP BY 1
     )
     SELECT COUNT(*)::int AS replied
       FROM logs l
       JOIN inbound i ON i.num = l.num AND i.last_in > l.sent_at`,
    [id, bRows[0].from_number]
  );

  // Stamp completed_at once every send has finished dispatching (no PENDING
  // rows left) — that's what "campaign completed" means for the sender. It
  // deliberately does NOT wait for read receipts: plenty of recipients never
  // open a message, so a read-based condition would leave most campaigns
  // showing "in progress" forever. Delivered/read keep climbing afterwards and
  // the KPI cards reflect that; only the send window is what's timed here.
  //
  // Guarded on status <> 'SENDING': /send flips the row to SENDING *before* it
  // inserts the new PENDING logs, so a poll landing in that window would
  // otherwise see the previous run's all-terminal rows, stamp NOW(), and — since
  // the stamp is monotonic — freeze a wrong completion time for the new run.
  const r0 = rollup[0] || {};
  const sendsFinished = (r0.total || 0) > 0 && (r0.pending || 0) === 0;
  if (sendsFinished && !bRows[0].completed_at && bRows[0].status !== 'SENDING') {
    const { rows: stamped } = await pool.query(
      `UPDATE coexistence.broadcasts SET completed_at = NOW()
        WHERE id = $1 AND completed_at IS NULL AND status <> 'SENDING'
        RETURNING completed_at`,
      [id]
    );
    if (stamped[0]) bRows[0].completed_at = stamped[0].completed_at;
  }

  // Normalise aggregated BROADCAST row to match the log shape the frontend expects
  const logs = [];
  if (broadcastAgg[0]?.recipient_count > 0) {
    logs.push({
      id: `broadcast-${id}`,
      action: 'BROADCAST',
      sent_to: `${broadcastAgg[0].recipient_count} contact${broadcastAgg[0].recipient_count !== 1 ? 's' : ''}`,
      status: broadcastAgg[0].status,
      sent_at: broadcastAgg[0].sent_at,
      wa_message_id: null,
      error_message: broadcastAgg[0].errors?.length ? broadcastAgg[0].errors.join('; ') : null,
      _recipientCount: broadcastAgg[0].recipient_count,
    });
  }
  logs.push(...testLogs);
  logs.sort((a, b) => new Date(b.sent_at || 0) - new Date(a.sent_at || 0));

  // started_at prefers the column set by /send; MIN(sent_at) is the fallback for
  // campaigns sent before that column existed.
  return {
    ...bRows[0],
    logs,
    statusRollup: {
      ...(rollup[0] || {}),
      replied: repliedRows[0]?.replied || 0,
      started_at: bRows[0].started_at || rollup[0]?.first_sent_at || null,
    },
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /broadcasts — list all with template name and live status rollup
router.get('/broadcasts', async (req, res) => {
  try {
    const { status } = req.query;

    const { rows } = await pool.query(
      `WITH base AS (
         SELECT b.*, t.name AS template_name,
                (SELECT COUNT(*) FROM coexistence.broadcast_logs WHERE broadcast_id = b.id) AS log_count,
                (SELECT MAX(sent_at) FROM coexistence.broadcast_logs WHERE broadcast_id = b.id) AS last_activity,
                (
                  SELECT
                    CASE
                      WHEN b.status = 'DRAFT' THEN 'DRAFT'
                      WHEN b.status = 'SENDING' THEN 'SENDING'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'PENDING') > 0 THEN 'SENDING'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0
                       AND COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) = 0 THEN 'FAILED'
                      WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0 THEN 'PARTIAL'
                      WHEN COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) > 0 THEN 'SENT'
                      ELSE b.status
                    END
                  FROM coexistence.broadcast_logs bl
                  WHERE bl.broadcast_id = b.id AND bl.action = 'BROADCAST'
                ) AS display_status
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.message_templates t ON t.id = b.template_id
       )
       SELECT * FROM base
       ${status && status !== 'all' ? 'WHERE display_status = $1' : ''}
       ORDER BY created_at DESC`,
      status && status !== 'all' ? [status] : []
    );
    // Map display_status over status for the frontend
    res.json(rows.map(r => ({ ...r, status: r.display_status || r.status })));
  } catch (err) {
    console.error('[broadcasts] /broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcasts' });
  }
});

// GET /broadcasts/counts — live counts per display_status, for the list view's
// filter tab badges. Registered before /broadcasts/:id so Express doesn't match
// "counts" as an :id. Unlike the list endpoint (which is filtered by the active
// tab), this always reflects every broadcast — so switching tabs doesn't zero
// out the other tabs' badges.
router.get('/broadcasts/counts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT display_status, COUNT(*)::int AS count FROM (
         SELECT b.id,
                CASE
                  WHEN b.status = 'DRAFT' THEN 'DRAFT'
                  WHEN b.status = 'SENDING' THEN 'SENDING'
                  WHEN COUNT(*) FILTER (WHERE bl.status = 'PENDING') > 0 THEN 'SENDING'
                  WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0
                   AND COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) = 0 THEN 'FAILED'
                  WHEN COUNT(*) FILTER (WHERE bl.status = 'failed') > 0 THEN 'PARTIAL'
                  WHEN COUNT(*) FILTER (WHERE bl.status IN ('sent','delivered','read')) > 0 THEN 'SENT'
                  ELSE b.status
                END AS display_status
         FROM coexistence.broadcasts b
         LEFT JOIN coexistence.broadcast_logs bl ON bl.broadcast_id = b.id AND bl.action = 'BROADCAST'
         GROUP BY b.id, b.status
       ) t
       GROUP BY display_status`
    );
    const counts = { all: 0, DRAFT: 0, SENDING: 0, SENT: 0, PARTIAL: 0, FAILED: 0 };
    for (const r of rows) {
      counts.all += r.count;
      if (counts[r.display_status] !== undefined) counts[r.display_status] = r.count;
    }
    res.json(counts);
  } catch (err) {
    console.error('[broadcasts] /broadcasts/counts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcast counts' });
  }
});

// GET /broadcasts/:id — single broadcast with template and logs
router.get('/broadcasts/:id', async (req, res) => {
  try {
    const data = await getBroadcastWithLogs(req.params.id);
    if (!data) return res.status(404).json({ error: 'Broadcast not found' });
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broadcast' });
  }
});

// POST /broadcasts — create broadcast + optional log entry
router.post('/broadcasts', requirePermission('bulk-message'), async (req, res) => {
  try {
    const {
      from_number, recipient_numbers, template_id, status, test_number,
      name, variable_mapping, message_type, body, url, media_library_id, caption,
    } = req.body;

    if (!from_number || !recipient_numbers) {
      return res.status(400).json({ error: 'from_number and recipient_numbers required' });
    }
    if (!Array.isArray(recipient_numbers) || recipient_numbers.length === 0) {
      return res.status(400).json({ error: 'recipient_numbers must be a non-empty array' });
    }
    if (recipient_numbers.length > 5000) {
      return res.status(400).json({ error: 'Too many recipients (max 5000 per broadcast)' });
    }

    const msgType = message_type || 'template';
    if (msgType === 'template' && !template_id) {
      return res.status(400).json({ error: 'template_id required for template broadcasts' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO coexistence.broadcasts
         (from_number, recipient_numbers, template_id, status, test_number, name,
          variable_mapping, message_type, body, url, media_library_id, caption, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         RETURNING *`,
        [
          from_number,
          JSON.stringify(recipient_numbers || []),
          template_id || null,
          status || 'DRAFT',
          test_number || null,
          name || null,
          JSON.stringify(variable_mapping || {}),
          msgType,
          body || null,
          url || null,
          media_library_id || null,
          caption || null,
        ]
      );
      const broadcast = rows[0];

      if (test_number) {
        await client.query(
          `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
           VALUES ($1, $2, $3, $4)`,
          [broadcast.id, 'TEST', test_number, 'PENDING']
        );
      }

      await client.query('COMMIT');
      res.status(201).json(broadcast);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts error:', err.message);
    res.status(500).json({ error: 'Failed to create broadcast' });
  }
});

// PUT /broadcasts/:id — update (only if DRAFT)
router.put('/broadcasts/:id', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rows: existing } = await pool.query(
      'SELECT status FROM coexistence.broadcasts WHERE id = $1', [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Broadcast not found' });
    if (existing[0].status !== 'DRAFT') {
      return res.status(403).json({ error: 'Only DRAFT broadcasts can be edited' });
    }

    const {
      from_number, recipient_numbers, template_id, test_number, name,
      variable_mapping, message_type, body, url, media_library_id, caption,
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE coexistence.broadcasts SET
        from_number = COALESCE($1, from_number),
        recipient_numbers = COALESCE($2, recipient_numbers),
        template_id = COALESCE($3, template_id),
        test_number = COALESCE($4, test_number),
        name = COALESCE($5, name),
        variable_mapping = COALESCE($6, variable_mapping),
        message_type = COALESCE($7, message_type),
        body = COALESCE($8, body),
        url = COALESCE($9, url),
        media_library_id = COALESCE($10, media_library_id),
        caption = COALESCE($11, caption),
        updated_at = NOW()
       WHERE id = $12
       RETURNING *`,
      [
        from_number || null,
        recipient_numbers ? JSON.stringify(recipient_numbers) : null,
        template_id || null,
        test_number || null,
        name || null,
        variable_mapping ? JSON.stringify(variable_mapping) : null,
        message_type || null,
        body || null,
        url || null,
        media_library_id || null,
        caption || null,
        req.params.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[broadcasts] PUT /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update broadcast' });
  }
});

// DELETE /broadcasts/:id
router.delete('/broadcasts/:id', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM coexistence.broadcasts WHERE id = $1', [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Broadcast not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[broadcasts] DELETE /broadcasts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete broadcast' });
  }
});

// POST /broadcasts/:id/send — real Meta send, one job per recipient via BullMQ
router.post('/broadcasts/:id/send', requirePermission('bulk-message'), async (req, res) => {
  try {
    const loaded = await loadBroadcastWithTemplate(req.params.id);
    if (!loaded) return res.status(404).json({ error: 'Broadcast not found' });
    const { broadcast, template } = loaded;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    const recipients = Array.isArray(broadcast.recipient_numbers) ? broadcast.recipient_numbers : [];
    if (recipients.length === 0) return res.status(400).json({ error: 'No recipients selected' });

    // For template broadcasts, preload each recipient's contact context so
    // field-mapped variables (name / custom_fields / category_tag) resolve to
    // real per-contact values.
    const contactCtx = broadcast.message_type === 'template'
      ? await loadContactContext(recipients.map(r => (typeof r === 'string' ? r : r.contact_number)))
      : new Map();

    const resolvedMediaId = await resolveHeaderMedia({ broadcast, template, account });

    // Each run times its own window: stamp started_at and clear completed_at,
    // since a repeat send adds fresh PENDING rows. Setting status='SENDING'
    // first also stops a concurrent poll from stamping completed_at against the
    // previous run's rows (see the guard in getBroadcastWithLogs).
    await pool.query(
      `UPDATE coexistence.broadcasts
          SET status = 'SENDING', started_at = NOW(), completed_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );

    let enqueued = 0;
    for (const r of recipients) {
      const base = typeof r === 'string' ? { contact_number: r, name: '' } : r;
      const ctx = contactCtx.get(String(base.contact_number || '').replace(/\D/g, '')) || {};
      const recipient = {
        ...base,
        name: base.name || ctx.name || '',
        custom_fields: ctx.custom_fields || base.custom_fields || {},
        tags: Array.isArray(ctx.tags) ? ctx.tags : (Array.isArray(base.tags) ? base.tags : []),
      };
      const { rows: logRows } = await pool.query(
        `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
         VALUES ($1, 'BROADCAST', $2, 'PENDING') RETURNING id`,
        [req.params.id, recipient.contact_number]
      );
      try {
        await enqueueBroadcastRecipient({
          broadcast, template, account, recipient, broadcastLogId: logRows[0].id, resolvedMediaId,
        });
        enqueued++;
      } catch (jobErr) {
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
          [jobErr.message.slice(0, 500), logRows[0].id]
        );
      }
    }

    await pool.query(
      `UPDATE coexistence.broadcasts SET status = 'SENT', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    const data = await getBroadcastWithLogs(req.params.id);
    res.json({ ...data, enqueued });
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/send error:', err.message);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// POST /broadcasts/:id/test — real Meta send to a single test number
router.post('/broadcasts/:id/test', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { test_number } = req.body;
    if (!test_number) return res.status(400).json({ error: 'test_number required' });

    const loaded = await loadBroadcastWithTemplate(req.params.id);
    if (!loaded) return res.status(404).json({ error: 'Broadcast not found' });
    const { broadcast, template } = loaded;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    const resolvedMediaId = await resolveHeaderMedia({ broadcast, template, account });

    const { rows: logRows } = await pool.query(
      `INSERT INTO coexistence.broadcast_logs (broadcast_id, action, sent_to, status)
       VALUES ($1, 'TEST', $2, 'PENDING') RETURNING id`,
      [req.params.id, test_number]
    );

    await enqueueBroadcastRecipient({
      broadcast, template, account,
      recipient: { contact_number: test_number, name: 'Test' },
      broadcastLogId: logRows[0].id,
      resolvedMediaId,
    });

    await pool.query(
      `UPDATE coexistence.broadcasts SET test_number = $1, updated_at = NOW() WHERE id = $2`,
      [test_number, req.params.id]
    );

    const data = await getBroadcastWithLogs(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/test error:', err.message);
    res.status(500).json({ error: 'Failed to send test' });
  }
});

// Per-recipient display status, derived the same way the aggregate rollup is:
// PENDING → 'pending'; failed → 'failed'; otherwise escalate through
// chat_history's tracked status (sent/delivered/read) for that message.
// Lowercased because migration 040 kept the legacy uppercase 'PENDING'/'SENT'/
// 'FAILED' values valid for rows written before the delivery statuses existed —
// an old 'FAILED' row must still read as failed (and get a Retry button).
function recipientDisplayStatus(row) {
  const blStatus = String(row.bl_status || '').toLowerCase();
  if (blStatus === 'pending') return 'pending';
  if (blStatus === 'failed') return 'failed';
  if (row.chat_status === 'read') return 'read';
  if (row.chat_status === 'delivered') return 'delivered';
  return 'sent';
}

// GET /broadcasts/:id/recipients — one row per recipient. If a broadcast was
// repeated, only the most recent attempt for each contact is shown (matches
// what "current delivery status per recipient" means) — retrying reuses the
// same log row so this never has to pick between duplicates either.
router.get('/broadcasts/:id/recipients', async (req, res) => {
  try {
    const { rows: bRows } = await pool.query(
      'SELECT recipient_numbers, from_number FROM coexistence.broadcasts WHERE id = $1',
      [req.params.id]
    );
    if (bRows.length === 0) return res.status(404).json({ error: 'Broadcast not found' });

    // Fallback name source: the recipient list captured when the campaign was
    // created (covers a contact later renamed/deleted from the Contacts panel).
    const nameByNumber = new Map();
    const recipientList = Array.isArray(bRows[0].recipient_numbers) ? bRows[0].recipient_numbers : [];
    for (const r of recipientList) {
      if (r && typeof r === 'object' && r.contact_number) {
        nameByNumber.set(String(r.contact_number).replace(/\D/g, ''), r.name || '');
      }
    }

    const { rows } = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (regexp_replace(sent_to, '\\D', '', 'g'))
           id, sent_to, status AS bl_status, sent_at, wa_message_id, error_message
         FROM coexistence.broadcast_logs
         WHERE broadcast_id = $1 AND action = 'BROADCAST'
         ORDER BY regexp_replace(sent_to, '\\D', '', 'g'), sent_at DESC, id DESC
       )
       SELECT l.id AS log_id, l.sent_to, l.bl_status, l.sent_at, l.error_message,
              ch.status AS chat_status, c.name AS contact_name
       FROM latest l
       LEFT JOIN coexistence.chat_history ch ON ch.message_id = l.wa_message_id
       LEFT JOIN coexistence.contacts c
              ON regexp_replace(c.contact_number, '\\D', '', 'g') = regexp_replace(l.sent_to, '\\D', '', 'g')
             AND regexp_replace(c.wa_number, '\\D', '', 'g') = regexp_replace($2::text, '\\D', '', 'g')
       ORDER BY l.sent_at DESC NULLS LAST`,
      [req.params.id, bRows[0].from_number]
    );

    const recipients = rows.map(r => ({
      logId: r.log_id,
      contactNumber: r.sent_to,
      name: r.contact_name || nameByNumber.get(String(r.sent_to).replace(/\D/g, '')) || '',
      status: recipientDisplayStatus(r),
      errorMessage: r.error_message,
      sentAt: r.sent_at,
    }));
    res.json({ recipients });
  } catch (err) {
    console.error('[broadcasts] GET /broadcasts/:id/recipients error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recipients' });
  }
});

// POST /broadcasts/:id/recipients/:logId/retry — re-send to a single failed
// recipient. Resets the SAME log row to PENDING and re-enqueues (rather than
// inserting a new row) so the recipient still has exactly one "latest attempt".
router.post('/broadcasts/:id/recipients/:logId/retry', requirePermission('bulk-message'), async (req, res) => {
  try {
    const { rows: logRows } = await pool.query(
      `SELECT * FROM coexistence.broadcast_logs WHERE id = $1 AND broadcast_id = $2 AND action = 'BROADCAST'`,
      [req.params.logId, req.params.id]
    );
    if (logRows.length === 0) return res.status(404).json({ error: 'Recipient not found' });
    const log = logRows[0];
    // Lowercased — migration 040 kept legacy uppercase 'FAILED' rows valid.
    if (String(log.status).toLowerCase() !== 'failed') {
      return res.status(400).json({ error: 'Only failed recipients can be retried' });
    }

    const loaded = await loadBroadcastWithTemplate(req.params.id);
    if (!loaded) return res.status(404).json({ error: 'Broadcast not found' });
    const { broadcast, template } = loaded;

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    const resolvedMediaId = await resolveHeaderMedia({ broadcast, template, account });

    const ctxMap = broadcast.message_type === 'template'
      ? await loadContactContext([log.sent_to])
      : new Map();
    const ctx = ctxMap.get(String(log.sent_to).replace(/\D/g, '')) || {};
    const recipient = { contact_number: log.sent_to, name: ctx.name || '', custom_fields: ctx.custom_fields || {}, tags: ctx.tags || [] };

    await pool.query(
      `UPDATE coexistence.broadcast_logs SET status = 'PENDING', error_message = NULL, wa_message_id = NULL, sent_at = NOW() WHERE id = $1`,
      [log.id]
    );
    // A retry un-terminal-izes the campaign — clear completed_at so the detail
    // view resumes showing "in progress" (and polling) until this settles too.
    await pool.query(`UPDATE coexistence.broadcasts SET completed_at = NULL WHERE id = $1`, [req.params.id]);

    try {
      await enqueueBroadcastRecipient({ broadcast, template, account, recipient, broadcastLogId: log.id, resolvedMediaId });
    } catch (jobErr) {
      await pool.query(
        `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
        [jobErr.message.slice(0, 500), log.id]
      );
    }

    res.json(await getBroadcastWithLogs(req.params.id));
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/recipients/:logId/retry error:', err.message);
    res.status(500).json({ error: 'Failed to retry recipient' });
  }
});

// POST /broadcasts/:id/retry-failed — retry every currently-failed recipient
// (latest attempt per contact) in one action.
router.post('/broadcasts/:id/retry-failed', requirePermission('bulk-message'), async (req, res) => {
  try {
    const loaded = await loadBroadcastWithTemplate(req.params.id);
    if (!loaded) return res.status(404).json({ error: 'Broadcast not found' });
    const { broadcast, template } = loaded;

    const { rows: toRetry } = await pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (regexp_replace(sent_to, '\\D', '', 'g'))
           id, sent_to, status
         FROM coexistence.broadcast_logs
         WHERE broadcast_id = $1 AND action = 'BROADCAST'
         ORDER BY regexp_replace(sent_to, '\\D', '', 'g'), sent_at DESC, id DESC
       )
       SELECT id, sent_to FROM latest WHERE LOWER(status) = 'failed'`,
      [req.params.id]
    );

    if (toRetry.length === 0) {
      return res.json({ ...(await getBroadcastWithLogs(req.params.id)), retried: 0 });
    }

    const { account, error } = await resolveAccount({ fromPhoneNumber: broadcast.from_number });
    if (error) return res.status(400).json({ error });

    const resolvedMediaId = await resolveHeaderMedia({ broadcast, template, account });
    const contactCtx = broadcast.message_type === 'template'
      ? await loadContactContext(toRetry.map(r => r.sent_to))
      : new Map();

    await pool.query(`UPDATE coexistence.broadcasts SET completed_at = NULL WHERE id = $1`, [req.params.id]);

    let retried = 0;
    for (const row of toRetry) {
      const ctx = contactCtx.get(String(row.sent_to).replace(/\D/g, '')) || {};
      const recipient = { contact_number: row.sent_to, name: ctx.name || '', custom_fields: ctx.custom_fields || {}, tags: ctx.tags || [] };
      await pool.query(
        `UPDATE coexistence.broadcast_logs SET status = 'PENDING', error_message = NULL, wa_message_id = NULL, sent_at = NOW() WHERE id = $1`,
        [row.id]
      );
      try {
        await enqueueBroadcastRecipient({ broadcast, template, account, recipient, broadcastLogId: row.id, resolvedMediaId });
        retried++;
      } catch (jobErr) {
        await pool.query(
          `UPDATE coexistence.broadcast_logs SET status='failed', error_message=$1 WHERE id=$2`,
          [jobErr.message.slice(0, 500), row.id]
        );
      }
    }

    res.json({ ...(await getBroadcastWithLogs(req.params.id)), retried });
  } catch (err) {
    console.error('[broadcasts] POST /broadcasts/:id/retry-failed error:', err.message);
    res.status(500).json({ error: 'Failed to retry failed recipients' });
  }
});

module.exports = { router };
