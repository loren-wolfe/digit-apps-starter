/**
 * Where an activity row came from. Computed when the log is read so older rows
 * pick up the same labels without a migration.
 *
 * `sutton` and `shipstation` mean that system returned the outcome.
 * `app` means this template recorded it (settings, eligibility, mapping).
 * `channel` is a sales-channel adapter. `unknown` is an error or warning
 * whose message and detail do not identify a system.
 */

/** @typedef {'sutton' | 'shipstation' | 'channel' | 'app' | 'unknown'} ActivityOrigin */

const ORIGINS = new Set(['sutton', 'shipstation', 'channel', 'app', 'unknown']);

const APP_ACTIONS = new Set([
  'settings',
  'connect',
  'disconnect',
  'push_skip',
  'carrier_unmapped',
  'catalog_pull',
]);

const SUTTON_TEXT =
  /sutton api|digit api|sutton jwt|digit jwt|could not reach the sutton|could not reach the digit|sutton shipment not found|digit shipment not found|sutton graphql|digit graphql|\bjwt_token\b|sales order not found/i;

const SHIPSTATION_TEXT =
  /could not reach shipstation|rejected by shipstation|shipstation request failed|could not read shipstation|shipstation did not return|non-shipstation url|no shipstation label yet/i;

const APP_TEXT =
  /disconnect and reconnect to switch api versions|connect a shipstation account first/i;

/**
 * @param {unknown} detail
 * @returns {Record<string, unknown> | null}
 */
function detailObject(detail) {
  if (detail == null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  return /** @type {Record<string, unknown>} */ (detail);
}

/**
 * @param {{
 *   actor?: string | null,
 *   action?: string | null,
 *   status?: string | null,
 *   message?: string | null,
 *   detail?: unknown,
 * }} event
 * @returns {ActivityOrigin}
 */
export function inferActivityOrigin(event = {}) {
  const detail = detailObject(event.detail);
  const explicit = typeof detail?.origin === 'string' ? detail.origin : null;
  if (explicit && ORIGINS.has(explicit)) return /** @type {ActivityOrigin} */ (explicit);

  const action = String(event.action ?? '');
  const text = String(event.message ?? '');
  const status = String(event.status ?? '');

  if (event.actor === 'channel' || action.startsWith('channel.')) return 'channel';
  if (APP_ACTIONS.has(action) || APP_TEXT.test(text)) return 'app';
  if (action === 'packing_slip_download') return 'sutton';
  if (action === 'label_download') return 'shipstation';

  if (detail && Object.prototype.hasOwnProperty.call(detail, 'graphqlCode')) return 'sutton';
  if (SUTTON_TEXT.test(text)) return 'sutton';

  if (
    detail &&
    (Array.isArray(detail.errorCodes) || Object.prototype.hasOwnProperty.call(detail, 'requestId'))
  ) {
    return 'shipstation';
  }
  if (SHIPSTATION_TEXT.test(text)) return 'shipstation';

  if (status === 'error' || status === 'failed' || status === 'warning') return 'unknown';
  return 'app';
}
