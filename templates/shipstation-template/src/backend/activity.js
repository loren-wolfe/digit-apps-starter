import { inferActivityOrigin } from './activityOrigin.js';

const MESSAGE_MAX = 500;
const DETAIL_MAX = 2000;
const LIST_LIMIT = 100;

/** Calendar month, matched to SQLite `datetime('now', '-1 month')`. */
export const ACTIVITY_MAX_AGE = '-1 month';
/** Midnight for the prune job. The platform has no clock cron, only an interval. */
export const ACTIVITY_PRUNE_TIME_ZONE = 'America/Los_Angeles';
const MIDNIGHT_WINDOW_MINUTES = 10;

export function pacificClock(date = new Date(), timeZone = ACTIVITY_PRUNE_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return { hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** Calendar date in America/Los_Angeles, `YYYY-MM-DD`. */
export function pacificDate(date = new Date(), timeZone = ACTIVITY_PRUNE_TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** True from 12:00 AM through 12:09 AM Pacific, wide enough for a 5-minute schedule to land. */
export function isActivityPruneWindow(date = new Date()) {
  const { hour, minute } = pacificClock(date);
  return hour === 0 && minute < MIDNIGHT_WINDOW_MINUTES;
}

export async function pruneActivityLog({ db, now = new Date() }) {
  if (!isActivityPruneWindow(now)) return { deleted: 0, skipped: true };
  const result = await db
    .prepare(`DELETE FROM activity_log WHERE created_at < datetime('now', ?)`)
    .bind(ACTIVITY_MAX_AGE)
    .run();
  return { deleted: result?.meta?.changes ?? 0, skipped: false };
}

export function truncateMessage(text, max = MESSAGE_MAX) {
  const value = String(text ?? '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/** Operator-facing line for a Sutton sales-order or shipment mutation. */
export function suttonUpdateMessage({ verb = 'Updated', kind, label, changes, message }) {
  const object = kind === 'order' ? 'sales order' : 'shipment';
  const name = String(label || '').trim();
  const target = name && name.toLowerCase() !== object ? `Sutton ${object} ${name}` : `Sutton ${object}`;
  if (message) {
    const action = verb === 'Created' ? 'create' : 'update';
    return truncateMessage(`Could not ${action} ${target}: ${message}`);
  }
  const shown = (changes ?? []).map((change) => String(change || '').trim()).filter(Boolean);
  const detail = shown.length > 0 ? shown.join(', ') : 'fields sent by this app';
  const action = verb === 'Created' ? 'Created' : 'Updated';
  return truncateMessage(`${action} ${target}: ${detail}.`);
}

function stringifyDetail(detail) {
  if (detail == null) return null;
  let raw;
  try {
    raw = typeof detail === 'string' ? detail : JSON.stringify(detail);
  } catch {
    return null;
  }
  return truncateMessage(raw, DETAIL_MAX);
}

export async function appendActivity({
  db,
  organizationId,
  actor,
  action,
  status,
  message,
  digitOrderId = null,
  ssShipmentId = null,
  channelId = null,
  externalOrderId = null,
  detail = null,
}) {
  if (!organizationId) return;
  await db
    .prepare(
      `INSERT INTO activity_log
         (organization_id, actor, action, digit_order_id, ss_shipment_id, channel_id, external_order_id, status, message, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      organizationId,
      actor,
      action,
      digitOrderId,
      ssShipmentId,
      channelId,
      externalOrderId,
      status,
      truncateMessage(message) || 'No message.',
      stringifyDetail(detail),
    )
    .run();
}

export function publicActivityRow(row) {
  let detail = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = row.detail;
    }
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdAt: row.created_at,
    actor: row.actor,
    action: row.action,
    digitOrderId: row.digit_order_id,
    ssShipmentId: row.ss_shipment_id,
    channelId: row.channel_id ?? null,
    externalOrderId: row.external_order_id ?? null,
    status: row.status,
    message: row.message,
    detail,
    origin: inferActivityOrigin({
      actor: row.actor,
      action: row.action,
      status: row.status,
      message: row.message,
      detail,
    }),
  };
}

export async function listActivity({ db, organizationId, limit = LIST_LIMIT }) {
  const { results } = await db
    .prepare(
      `SELECT id, organization_id, created_at, actor, action, digit_order_id, ss_shipment_id,
              channel_id, external_order_id, status, message, detail
       FROM activity_log
       WHERE organization_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(organizationId, Math.min(Math.max(Number(limit) || LIST_LIMIT, 1), LIST_LIMIT))
    .all();
  return (results ?? []).map(publicActivityRow);
}
