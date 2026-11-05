/**
 * D1 helpers for channel connections, order maps, and webhook idempotency.
 */

export async function webhookAlreadyProcessed({ db, channelId, deliveryId }) {
  if (!db || !channelId || !deliveryId) return false;
  const row = await db
    .prepare(
      `SELECT id FROM webhook_delivery WHERE channel_id = ? AND delivery_id = ? LIMIT 1`,
    )
    .bind(channelId, deliveryId)
    .first();
  return Boolean(row);
}

export async function recordWebhookDelivery({
  db,
  channelId,
  deliveryId,
  processed = false,
}) {
  if (!db || !channelId || !deliveryId) return;
  await db
    .prepare(
      `INSERT INTO webhook_delivery (channel_id, delivery_id, processed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(channel_id, delivery_id) DO NOTHING`,
    )
    .bind(channelId, deliveryId, processed ? new Date().toISOString() : null)
    .run();
}

export async function markWebhookDeliveryProcessed({ db, channelId, deliveryId }) {
  if (!db || !channelId || !deliveryId) return;
  await db
    .prepare(
      `UPDATE webhook_delivery
       SET processed_at = datetime('now')
       WHERE channel_id = ? AND delivery_id = ?`,
    )
    .bind(channelId, deliveryId)
    .run();
}

export async function upsertChannelOrderMap({
  db,
  organizationId,
  channelId,
  digitOrderId = null,
  externalOrderId,
  pushStatus,
  lastError = null,
}) {
  if (!db || !organizationId || !channelId || !externalOrderId) return;
  await db
    .prepare(
      `INSERT INTO channel_order_map
         (organization_id, channel_id, digit_order_id, external_order_id, push_status, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(organization_id, channel_id, external_order_id) DO UPDATE SET
         digit_order_id = COALESCE(excluded.digit_order_id, channel_order_map.digit_order_id),
         push_status = excluded.push_status,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    )
    .bind(organizationId, channelId, digitOrderId, externalOrderId, pushStatus, lastError)
    .run();
}

export async function listChannelConnections({ db, organizationId }) {
  if (!db || !organizationId) return [];
  const { results } = await db
    .prepare(
      `SELECT id, channel_id, external_store_id, config_json, enabled
       FROM channel_connection
       WHERE organization_id = ? AND deleted = 0
       ORDER BY channel_id ASC`,
    )
    .bind(organizationId)
    .all();
  return (results ?? []).map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    externalStoreId: row.external_store_id,
    config: safeJson(row.config_json),
    enabled: row.enabled === 1,
  }));
}

function safeJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

export async function organizationIdForChannelWebhook({ env, db }) {
  if (db) {
    const fromChannel = await db
      .prepare(
        `SELECT organization_id FROM channel_connection WHERE deleted = 0 AND enabled = 1 LIMIT 1`,
      )
      .first();
    if (fromChannel?.organization_id) return fromChannel.organization_id;
    const fromShipStation = await db
      .prepare(
        `SELECT organization_id FROM shipstation_connection WHERE deleted = 0 LIMIT 1`,
      )
      .first();
    if (fromShipStation?.organization_id) return fromShipStation.organization_id;
  }
  void env;
  return null;
}
