/**
 * Idempotent Digit ↔ ShipStation order sync.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { requireEnv } from '@heysutton/sdk-server';

import { queryMapsBySearch } from './mapSearch.js';
import { afterDigitShipped } from './channels/index.js';
import { digitGraphql } from './digitGraphql.js';
import { appendActivity, suttonUpdateMessage } from './activity.js';
import {
  COMPANIES_SEARCH_QUERY,
  CREATE_COMPANY_LOCATION_MUTATION,
  CREATE_COMPANY_MUTATION,
  CREATE_ORDER_MUTATION,
  CREATE_PACK_CONTAINER_MUTATION,
  CREATE_SHIPMENT_MUTATION,
  GENERATE_SALES_ORDER_PDF_QUERY,
  ITEMS_BY_SEARCH_QUERY,
  ORDER_BY_ID_QUERY,
  SHIPMENT_BY_ID_QUERY,
  SHIPMENT_LIST_QUERY,
  UPDATE_ORDER_MUTATION,
  UPDATE_SHIPMENT_MUTATION,
} from './digitQueries.js';
import {
  effectiveShippingCarrierField,
  failedPushNeedsManualRetry,
  ineligibilityReason,
  skipNeedsAttention,
  skipNextStep,
} from './eligibility.js';
import { digitShipmentToShipment, orgShipFrom } from './mappers/digitToShipStation.js';
import { digitShipmentToV1Order } from './mappers/digitToShipStationV1.js';
import {
  digitShippingStatusFromSs,
  digitShippingStatusFromTrackingStatus,
} from './mappers/digitShippingStatus.js';
import { salesOrderStatusAfterLabelReturn } from './mappers/salesOrderStatus.js';
import {
  normalizeSsRecord,
  normalizedToImportShipment,
  packingSlipCarrierChoice,
  summedShippingFees,
} from './mappers/normalizeSsRecord.js';
import {
  ssBillingAddressInput,
  ssCompanyName,
  ssLineSkus,
  ssShipToLocationInput,
} from './mappers/shipStationToDigit.js';
import { resolveShipStationCredentials } from './runtimeConfig.js';
import {
  normalizeSourceFilter,
  SOURCE_EXCLUDED_REASON,
  shipmentSourceKey,
  sourceExcluded,
} from './sourceFilter.js';
import { pdfBase64FromV2Label } from './labels.js';
import { resolveDigitCarrier, resolveSsServiceForDigitShipment } from './matchDigitCarrier.js';
import { pulledPackagesFromRecord, storedPushCatalog } from './packageCatalog.js';
import {
  clearPackageSelection,
  matchPulledPackages,
  missingPackageTypeReason,
  resolvePushPackageSelections,
  saveObservedPackage,
  selectionForContainer,
  selectionsForShipment,
} from './packageSelection.js';
import { bytesToBase64 } from './shipstationFetch.js';
import {
  createShipments,
  getLabel,
  getShipment,
  getShipmentByExternalId,
  listLabels,
} from './shipstation.js';

export async function liveConnection({ db, organizationId }) {
  return db
    .prepare(
      `SELECT id, organization_id, api_version, created_at, updated_at
       FROM shipstation_connection
       WHERE organization_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(organizationId)
    .first();
}

/**
 * Live ShipStation credentials for a connected org.
 * Secrets come from Digit app secrets only. Legacy `api_key_encrypted` on the
 * connection row is not used here — removing the Digit secret must clear
 * operable/connected UI.
 *
 * @returns {Promise<null | {
 *   connectionId: number,
 *   apiVersion: 'v1' | 'v2',
 *   apiKey?: string,
 *   apiSecret?: string,
 *   mismatch?: string,
 * }>}
 */
export async function liveCredentials({ db, env, organizationId }) {
  const row = await db
    .prepare(
      `SELECT id, api_version FROM shipstation_connection
       WHERE organization_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(organizationId)
    .first();
  if (!row) return null;

  const storedVersion = row.api_version === 'v1' ? 'v1' : 'v2';
  const resolved = await resolveShipStationCredentials({ env, db });
  if (!resolved) return null;

  if (resolved.apiVersion !== storedVersion) {
    return {
      connectionId: row.id,
      apiVersion: storedVersion,
      mismatch:
        `ShipStation secrets are ${resolved.apiVersion.toUpperCase()} but this connection was opened as ${storedVersion.toUpperCase()}. Disconnect and reconnect to switch API versions.`,
    };
  }
  return {
    connectionId: row.id,
    apiVersion: storedVersion,
    apiKey: resolved.apiKey,
    ...(resolved.apiSecret ? { apiSecret: resolved.apiSecret } : {}),
  };
}

export function publicConnection(row, extra = {}) {
  const credentialsMissing = Boolean(extra.credentialsMissing);
  return {
    id: row.id,
    organizationId: row.organization_id,
    // Row may still exist after secrets were removed — that is not "connected".
    connected: !credentialsMissing,
    staleConnection: credentialsMissing || Boolean(extra.staleConnection),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    apiVersion: row.api_version || extra.apiVersion || 'v2',
    ...(extra.carrierCount !== undefined ? { carrierCount: extra.carrierCount } : {}),
    ...(extra.mismatch ? { mismatch: extra.mismatch } : {}),
    ...(credentialsMissing ? { credentialsMissing: true } : {}),
  };
}

/** Credentials object for shipstation.js, or null when the connection cannot call ShipStation. */
export function credentialsForApi(secret) {
  if (!secret || secret.mismatch || !secret.apiKey) return null;
  return {
    apiVersion: secret.apiVersion,
    apiKey: secret.apiKey,
    ...(secret.apiSecret ? { apiSecret: secret.apiSecret } : {}),
  };
}

function reconnectMessage(secret) {
  return secret?.mismatch || 'Connect a ShipStation account first.';
}

export function normalizeOrgSettings(row, organizationId, { includeLegacyDimensions = false } = {}) {
  const weight = Number(row?.default_weight_oz);
  const length = Number(row?.default_length_in);
  const width = Number(row?.default_width_in);
  const height = Number(row?.default_height_in);
  return {
    organizationId,
    defaultFulfillmentMethod:
      row?.default_fulfillment_method === 'scheduled' ? 'scheduled' : 'manual',
    defaultWeightOz: Number.isFinite(weight) && weight > 0 ? weight : 16,
    sourceFilter: normalizeSourceFilter(row?.source_filter_enabled, row?.source_filter_keys),
    ...(includeLegacyDimensions
      ? {
          defaultLengthIn: Number.isFinite(length) && length > 0 ? length : null,
          defaultWidthIn: Number.isFinite(width) && width > 0 ? width : null,
          defaultHeightIn: Number.isFinite(height) && height > 0 ? height : null,
        }
      : {}),
  };
}

export async function loadOrgSettings({ db, organizationId, includeLegacyDimensions = false }) {
  const row = await db
    .prepare(
      `SELECT organization_id, default_fulfillment_method, default_weight_oz,
              default_length_in, default_width_in, default_height_in,
              source_filter_enabled, source_filter_keys
       FROM org_settings WHERE organization_id = ?`,
    )
    .bind(organizationId)
    .first();
  return normalizeOrgSettings(row, organizationId, { includeLegacyDimensions });
}

export function publicMapRow(row) {
  if (!row) return null;
  return {
    digitOrderId: row.digit_order_id,
    digitShipmentId: row.digit_shipment_id,
    ssShipmentId: row.ss_shipment_id,
    ssLabelId: row.ss_label_id,
    hasLabel: Boolean(row.ss_label_id) || Boolean(row.has_label_pdf),
    source: row.source,
    pushStatus: row.push_status,
    lastError: row.last_error,
    trackingNumber: row.tracking_number,
    trackingStatus: row.tracking_status ?? null,
    carrierName: row.carrier_name,
    shipDate: row.ship_date,
    shipmentCostAmount: row.shipment_cost_amount,
    shipmentCostCurrency: row.shipment_cost_currency,
  };
}

const MAP_ROW_SELECT = `SELECT digit_order_id, digit_shipment_id, ss_shipment_id, ss_label_id, source,
              push_status, last_error, tracking_number, tracking_status, carrier_name, ship_date,
              shipment_cost_amount, shipment_cost_currency,
              CASE WHEN label_pdf_base64 IS NOT NULL AND length(label_pdf_base64) > 0 THEN 1 ELSE 0 END AS has_label_pdf
       FROM shipstation_order_map`;

export async function mapsForShipments({ db, connectionId, shipmentIds }) {
  if (!shipmentIds.length) return [];
  const placeholders = shipmentIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `${MAP_ROW_SELECT}
       WHERE connection_id = ? AND deleted = 0 AND digit_shipment_id IN (${placeholders})`,
    )
    .bind(connectionId, ...shipmentIds)
    .all();
  return (results ?? []).map(publicMapRow);
}

export async function mapsMatchingQuery({ db, connectionId, query }) {
  return queryMapsBySearch({
    db,
    connectionId,
    query,
    selectSql: MAP_ROW_SELECT,
    mapRow: publicMapRow,
  });
}

export async function mapsForOrders({ db, connectionId, orderIds }) {
  if (!orderIds.length) return [];
  const placeholders = orderIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `${MAP_ROW_SELECT}
       WHERE connection_id = ? AND deleted = 0 AND digit_order_id IN (${placeholders})`,
    )
    .bind(connectionId, ...orderIds)
    .all();
  return (results ?? []).map(publicMapRow);
}

async function shippingFeesForDigitOrder({ db, connectionId, digitOrderId }) {
  if (!connectionId || !digitOrderId) return null;
  const { results } = await db
    .prepare(
      `SELECT shipment_cost_amount, shipment_cost_currency
       FROM shipstation_order_map
       WHERE connection_id = ? AND digit_order_id = ? AND deleted = 0`,
    )
    .bind(connectionId, digitOrderId)
    .all();
  return summedShippingFees(results);
}

async function applyOrderShippingFees({
  env,
  orderId,
  shippingFees,
  shippingCarrierFieldId = null,
  orderStatus = null,
}) {
  if (!orderId || (!shippingFees && !shippingCarrierFieldId && !orderStatus)) {
    return { ok: true, data: { skipped: true } };
  }
  return digitGraphql({
    env,
    query: UPDATE_ORDER_MUTATION,
    variables: {
      input: {
        orderId,
        ...(orderStatus ? { orderStatus } : {}),
        ...(shippingFees ? { shippingFees } : {}),
        ...(shippingCarrierFieldId ? { shippingCarrierFieldId } : {}),
      },
    },
  });
}

/**
 * Carrier to print on the packing slip. The purchased ShipStation label is
 * read again so a sales-order carrier such as FedEx 2Day is not reused after
 * a different service was bought. Newest mapped shipment wins.
 */
async function packingSlipCarrierForOrder({
  env,
  db,
  organizationId,
  connectionId,
  orderId,
  credentials = null,
}) {
  const empty = { shippingCarrierFieldId: null, digitShipmentId: null };
  if (!connectionId || !orderId) return empty;
  const { results } = await db
    .prepare(
      `SELECT digit_shipment_id, ss_shipment_id, carrier_name, service_code, service_name
       FROM shipstation_order_map
       WHERE connection_id = ? AND digit_order_id = ? AND deleted = 0
       ORDER BY id DESC`,
    )
    .bind(connectionId, orderId)
    .all();
  const rows = results ?? [];
  if (!rows.length) return empty;

  let order = null;
  let fetched = false;
  async function shipmentOptionId(shipmentId) {
    if (!shipmentId) return null;
    if (!fetched) {
      fetched = true;
      const loaded = await fetchDigitOrder({ env, orderId });
      order = loaded.ok ? loaded.data.order : null;
    }
    const shipment = order?.shipments?.find((item) => item.id === shipmentId);
    return shipment?.shippingCarrierField?.id || null;
  }

  const choices = [];
  for (const row of rows) {
    const live = await labelCarrierForMapRow({ credentials, row });
    const carrierCode = live?.carrierCode || row.carrier_name;
    const serviceCode = live?.serviceCode || row.service_code;
    const serviceName = live?.serviceCode ? null : row.service_name;
    const resolved = await resolveDigitCarrier({
      env,
      db,
      organizationId,
      connectionId,
      carrierCode,
      carrierName: carrierCode,
      serviceCode,
      serviceName,
      actor: 'user',
      digitOrderId: orderId,
      recordActivity: false,
    });
    choices.push({
      digitShipmentId: row.digit_shipment_id,
      shipmentOptionId: await shipmentOptionId(row.digit_shipment_id),
      resolvedOptionId: resolved.ok ? resolved.data.digitOptionId : null,
    });
  }
  const choice = packingSlipCarrierChoice(choices);
  return {
    shippingCarrierFieldId: choice.optionId,
    digitShipmentId: choice.shipmentId,
  };
}

async function labelCarrierForMapRow({ credentials, row }) {
  if (!credentials || !row?.ss_shipment_id) return null;
  const looked = await lookupSsFulfillmentRecord({
    credentials,
    map: {
      ss_shipment_id: row.ss_shipment_id,
      digit_shipment_id: row.digit_shipment_id,
    },
  });
  if (!looked.record) return null;
  const normalized = normalizeSsRecord(looked.record);
  if (!normalized.carrierCode && !normalized.serviceCode) return null;
  return normalized;
}

async function applyMappedShippingFeesToOrder({ env, db, organizationId, orderId }) {
  const secret = await liveCredentials({ db, env, organizationId });
  if (!secret?.connectionId) return { ok: true, data: { skipped: true } };
  const shippingFees = await shippingFeesForDigitOrder({
    db,
    connectionId: secret.connectionId,
    digitOrderId: orderId,
  });
  const carrier = await packingSlipCarrierForOrder({
    env,
    db,
    organizationId,
    connectionId: secret.connectionId,
    orderId,
    credentials: credentialsForApi(secret),
  });
  const updated = await applyOrderShippingFees({
    env,
    orderId,
    shippingFees,
    shippingCarrierFieldId: carrier.shippingCarrierFieldId,
  });
  if (!updated.ok || !updated.data?.skipped) {
    await logSuttonUpdate({
      db,
      organizationId,
      kind: 'order',
      digitOrderId: orderId,
      ok: updated.ok,
      message: updated.ok ? null : updated.message,
      changes: orderFeeChanges({
        shippingFees,
        shippingCarrierFieldId: carrier.shippingCarrierFieldId,
      }),
    });
  }
  if (!updated.ok) return updated;
  if (carrier.shippingCarrierFieldId && carrier.digitShipmentId) {
    const shipmentUpdate = await digitGraphql({
      env,
      query: UPDATE_SHIPMENT_MUTATION,
      variables: {
        input: {
          shipmentId: carrier.digitShipmentId,
          shippingCarrierFieldId: carrier.shippingCarrierFieldId,
        },
      },
    });
    await logSuttonUpdate({
      db,
      organizationId,
      kind: 'shipment',
      digitOrderId: orderId,
      ok: shipmentUpdate.ok,
      message: shipmentUpdate.ok ? null : shipmentUpdate.message,
      changes: ['shipping carrier'],
    });
  }
  return updated;
}

async function upsertMap({ db, connectionId, organizationId, digitOrderId, digitShipmentId, fields }) {
  let existing = null;
  if (digitShipmentId) {
    existing = await db
      .prepare(
        `SELECT id FROM shipstation_order_map
         WHERE connection_id = ? AND digit_shipment_id = ? AND deleted = 0
         LIMIT 1`,
      )
      .bind(connectionId, digitShipmentId)
      .first();
  }
  if (!existing && digitOrderId && !digitShipmentId) {
    existing = await db
      .prepare(
        `SELECT id FROM shipstation_order_map
         WHERE connection_id = ? AND digit_order_id = ? AND deleted = 0
         LIMIT 1`,
      )
      .bind(connectionId, digitOrderId)
      .first();
  }

  const shipmentId = digitShipmentId ?? fields.digitShipmentId ?? null;

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO shipstation_order_map
           (connection_id, organization_id, digit_order_id, ss_shipment_id, ss_label_id,
            digit_shipment_id, source, push_status, last_error, tracking_number, tracking_status,
            carrier_name, service_code, service_name, ship_date, shipment_cost_amount,
            shipment_cost_currency, label_pdf_base64, channels_notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        connectionId,
        organizationId,
        digitOrderId,
        fields.ssShipmentId ?? null,
        fields.ssLabelId ?? null,
        shipmentId,
        fields.source ?? 'digit',
        fields.pushStatus ?? 'pending',
        fields.lastError ?? null,
        fields.trackingNumber ?? null,
        fields.trackingStatus ?? null,
        fields.carrierName ?? null,
        fields.serviceCode ?? null,
        fields.serviceName ?? null,
        fields.shipDate ?? null,
        fields.shipmentCostAmount ?? null,
        fields.shipmentCostCurrency ?? null,
        fields.labelPdfBase64 ?? null,
        fields.channelsNotified ?? 0,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `UPDATE shipstation_order_map SET
         ss_shipment_id = COALESCE(?, ss_shipment_id),
         ss_label_id = COALESCE(?, ss_label_id),
         digit_shipment_id = COALESCE(?, digit_shipment_id),
         source = COALESCE(?, source),
         push_status = COALESCE(?, push_status),
         last_error = ?,
         tracking_number = COALESCE(?, tracking_number),
         tracking_status = COALESCE(?, tracking_status),
         carrier_name = COALESCE(?, carrier_name),
         service_code = COALESCE(?, service_code),
         service_name = COALESCE(?, service_name),
         ship_date = COALESCE(?, ship_date),
         shipment_cost_amount = COALESCE(?, shipment_cost_amount),
         shipment_cost_currency = COALESCE(?, shipment_cost_currency),
         label_pdf_base64 = COALESCE(?, label_pdf_base64),
         channels_notified = COALESCE(?, channels_notified),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(
      fields.ssShipmentId ?? null,
      fields.ssLabelId ?? null,
      shipmentId,
      fields.source ?? null,
      fields.pushStatus ?? null,
      fields.lastError === undefined ? null : fields.lastError,
      fields.trackingNumber ?? null,
      fields.trackingStatus ?? null,
      fields.carrierName ?? null,
      fields.serviceCode ?? null,
      fields.serviceName ?? null,
      fields.shipDate ?? null,
      fields.shipmentCostAmount ?? null,
      fields.shipmentCostCurrency ?? null,
      fields.labelPdfBase64 ?? null,
      fields.channelsNotified ?? null,
      existing.id,
    )
    .run();
}

async function mapBySsShipment({ db, connectionId, ssShipmentId }) {
  if (!ssShipmentId) return null;
  return db
    .prepare(
      `SELECT * FROM shipstation_order_map
       WHERE connection_id = ? AND ss_shipment_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(connectionId, ssShipmentId)
    .first();
}

function orderFeeChanges({ shippingFees, shippingCarrierFieldId, orderStatus = null }) {
  const changes = [];
  if (orderStatus) changes.push(`order status ${String(orderStatus).replaceAll('_', ' ')}`);
  if (shippingFees?.costAmount != null) {
    const currency = shippingFees.currencyCode ? ` ${shippingFees.currencyCode}` : '';
    changes.push(`shipping fees ${shippingFees.costAmount}${currency}`);
  }
  if (shippingCarrierFieldId) changes.push('shipping carrier');
  return changes;
}

async function logSuttonUpdate({
  db,
  organizationId,
  actor = 'user',
  verb = 'Updated',
  kind,
  label,
  changes,
  ok = true,
  message = null,
  digitOrderId = null,
}) {
  if (!organizationId || !kind) return;
  await appendActivity({
    db,
    organizationId,
    actor,
    action: 'sutton_update',
    status: ok ? 'success' : 'error',
    message: suttonUpdateMessage({
      verb,
      kind,
      label,
      changes,
      message: ok ? null : message,
    }),
    digitOrderId,
    detail: { origin: 'sutton', kind, verb },
  });
}

export async function recordSuttonApiUpdate(args) {
  return logSuttonUpdate(args);
}

function recordsFromSsPayload(data) {
  if (!data) return [];
  if (Array.isArray(data.orders)) return data.orders;
  if (Array.isArray(data.shipments)) return data.shipments;
  if (Array.isArray(data)) return data;
  if (data.shipment) return [data.shipment];
  if (data.order) return [data.order];
  return [data];
}

function firstCreatedShipment(data) {
  return recordsFromSsPayload(data)[0] ?? null;
}

export async function fetchDigitOrder({ env, orderId }) {
  const result = await digitGraphql({
    env,
    query: ORDER_BY_ID_QUERY,
    variables: { orderIds: [orderId] },
  });
  if (!result.ok) return result;
  const order = result.data?.orders?.nodes?.[0] ?? null;
  const organization = result.data?.organization ?? null;
  if (!order) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'Sales order not found.',
      status: 400,
    };
  }
  return { ok: true, data: { order, organization } };
}

export async function fetchDigitShipment({ env, shipmentId }) {
  const result = await digitGraphql({
    env,
    query: SHIPMENT_BY_ID_QUERY,
    variables: { shipmentId },
  });
  if (!result.ok) return result;
  const shipment = result.data?.shipment ?? null;
  const organization = result.data?.organization ?? null;
  if (!shipment) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'Sutton shipment not found.',
      status: 400,
    };
  }
  return { ok: true, data: { shipment, organization } };
}

/** Eligibility skips must not clear a rejected create, or the next sweep would push it. */
function skipMapFields(existing) {
  if (['shipped', 'imported'].includes(existing?.push_status ?? '')) {
    return { pushStatus: existing.push_status, lastError: null };
  }
  if (existing?.ss_shipment_id) {
    return { pushStatus: 'pushed', lastError: null };
  }
  if (
    failedPushNeedsManualRetry({
      pushStatus: existing?.push_status,
      ssShipmentId: existing?.ss_shipment_id,
    })
  ) {
    return { pushStatus: 'error', lastError: existing?.last_error ?? null };
  }
  return { pushStatus: 'skipped', lastError: null };
}

function pushMeaning({ skipped, reason, ssShipmentId, shipmentLabel }) {
  if (skipped) {
    return `${reason} ${skipNextStep(reason)}`.trim();
  }
  return `Created ShipStation shipment ${ssShipmentId} for ${shipmentLabel}. Choose the carrier and buy the label in ShipStation. Tracking and cost appear after Pull from ShipStation or the next five-minute poll.`;
}

function shipmentLabel(shipment, shipmentId) {
  return (
    shipment?.documentNumber ||
    shipment?.shippingNumber ||
    shipment?.order?.documentNumber ||
    shipment?.order?.orderNumber ||
    shipmentId
  );
}

async function recordPushActivity({
  db,
  organizationId,
  actor,
  recordActivity,
  skipped,
  ok,
  orderId,
  ssShipmentId,
  message,
  detail,
  quiet = false,
}) {
  if (!recordActivity) return;
  if (quiet) return;
  if (actor === 'schedule' && skipped) return;
  await appendActivity({
    db,
    organizationId,
    actor,
    action: skipped ? 'push_skip' : ok ? 'push' : 'push_error',
    status: skipped ? 'skipped' : ok ? 'success' : 'error',
    message,
    digitOrderId: orderId,
    ssShipmentId: ssShipmentId ?? null,
    detail: detail ?? null,
  });
}

/**
 * `preloaded` lets the scheduled poll reuse the shipment it already listed. Without it every
 * candidate costs another Digit query, which is enough to hit the API rate limit.
 */
async function packageOverridesForPush({
  db,
  organizationId,
  connectionId,
  shipment,
  shipmentLabel: label,
  ssService,
  actor,
  recordActivity,
}) {
  const selections = await selectionsForShipment({
    db,
    connectionId,
    digitShipmentId: shipment?.id,
  });
  if (!selections.length) {
    return { ok: true, overrides: null, v1Selection: null };
  }
  const catalog = await storedPushCatalog({
    db,
    connectionId,
    carrierId: ssService?.carrierId,
    carrierCode: ssService?.carrierCode,
  });
  if (!catalog.ok) {
    return {
      ok: false,
      message: catalog.message || 'Could not list ShipStation package types.',
    };
  }
  const resolved = resolvePushPackageSelections({
    selections,
    carrier: ssService,
    customPackages: catalog.customPackages,
    carrierPackages: catalog.carrierPackages,
  });
  for (const stale of resolved.stale) {
    await clearPackageSelection({
      db,
      connectionId,
      digitContainerId: stale.digitContainerId,
    });
    if (recordActivity) {
      await appendActivity({
        db,
        organizationId,
        actor,
        action: 'package_selection',
        status: 'success',
        message: `Cleared ${stale.packageName || stale.packageCode} on ${label} because the mapped carrier changed.`,
        digitOrderId: shipment?.order?.id ?? null,
      });
    }
  }
  if (resolved.missing) {
    return { ok: true, skipReason: missingPackageTypeReason(resolved.missing) };
  }
  const containerId = String(shipment?.packContainers?.[0]?.id ?? '').trim();
  return {
    ok: true,
    overrides: resolved.overridesByContainerId,
    v1Selection: containerId ? (resolved.overridesByContainerId[containerId] ?? null) : null,
  };
}

export async function pushShipment({
  env,
  db,
  organizationId,
  shipmentId,
  actor = 'user',
  recordActivity = true,
  preloaded = null,
  sweep = false,
}) {
  const secret = await liveCredentials({ db, env, organizationId });
  const credentials = credentialsForApi(secret);
  if (!credentials) {
    const message = reconnectMessage(secret);
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: false,
      ok: false,
      orderId: null,
      ssShipmentId: null,
      message,
    });
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message,
      status: 400,
    };
  }
  const orgSettings = await loadOrgSettings({
    db,
    organizationId,
    includeLegacyDimensions: true,
  });
  const existing = await db
    .prepare(
      `SELECT * FROM shipstation_order_map
       WHERE connection_id = ? AND digit_shipment_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(secret.connectionId, shipmentId)
    .first();

  if (sweep && failedPushNeedsManualRetry(publicMapRow(existing))) {
    return {
      ok: true,
      data: {
        shipmentId,
        orderId: existing?.digit_order_id ?? null,
        skipped: true,
        needsAttention: false,
        message: existing?.last_error ?? null,
      },
    };
  }

  const loaded =
    preloaded?.shipment
      ? { ok: true, data: { shipment: preloaded.shipment, organization: preloaded.organization ?? null } }
      : await fetchDigitShipment({ env, shipmentId });
  if (!loaded.ok) {
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: false,
      ok: false,
      orderId: null,
      ssShipmentId: null,
      message: loaded.message,
      detail: loaded.detail ?? { code: loaded.code },
    });
    return loaded;
  }
  const { shipment, organization } = loaded.data;
  const orderId = shipment?.order?.id ?? null;
  const label = shipmentLabel(shipment, shipmentId);

  // No map write: an excluded shipment has no ShipStation state to keep or clear.
  if (sourceExcluded({ shipment, orgSettings, mapRow: existing ? publicMapRow(existing) : null })) {
    const reason = SOURCE_EXCLUDED_REASON;
    const meaning = pushMeaning({ skipped: true, reason, ssShipmentId: null, shipmentLabel: label });
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: true,
      ok: true,
      orderId,
      ssShipmentId: null,
      message: meaning,
      detail: { sourceKey: shipmentSourceKey(shipment) },
      quiet: sweep,
    });
    return {
      ok: true,
      data: {
        shipmentId,
        orderId,
        skipped: true,
        needsAttention: false,
        shipmentLabel: label,
        reason,
        message: reason,
        meaning,
      },
    };
  }

  const carrierField = effectiveShippingCarrierField(shipment);
  const ssService = await resolveSsServiceForDigitShipment({
    db,
    connectionId: secret.connectionId,
    digitOptionId: carrierField?.id ?? null,
    digitValue: carrierField?.value ?? null,
  });

  let reason = ineligibilityReason({
    shipment,
    orgSettings,
    mapRow: existing ? publicMapRow(existing) : null,
    apiVersion: secret.apiVersion,
    ssService,
  });
  if (
    !reason &&
    secret.apiVersion !== 'v1' &&
    ssService.status === 'ok' &&
    !ssService.carrierId
  ) {
    reason =
      'ShipStation carrier id is missing for the mapped service. Reconnect ShipStation to refresh carriers, then try again.';
  }
  if (reason) {
    if (orderId) {
      // Ineligibility is not a failure: keep the ShipStation state and leave lastError clear,
      // otherwise the 5-minute poll paints pushed shipments red and drops the already-pushed guard.
      // A rejected create stays `error` so a later skip does not hand the row back to the sweep.
      const retained = skipMapFields(existing);
      await upsertMap({
        db,
        connectionId: secret.connectionId,
        organizationId,
        digitOrderId: orderId,
        digitShipmentId: shipmentId,
        fields: {
          pushStatus: retained.pushStatus,
          lastError: retained.lastError,
          source: existing?.source ?? 'digit',
        },
      });
    }
    const meaning = pushMeaning({ skipped: true, reason, ssShipmentId: existing?.ss_shipment_id ?? null, shipmentLabel: label });
    const needsAttention = skipNeedsAttention(reason);
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: true,
      ok: true,
      orderId,
      ssShipmentId: existing?.ss_shipment_id ?? null,
      message: meaning,
      quiet: sweep && !needsAttention,
    });
    return {
      ok: true,
      data: {
        shipmentId,
        orderId,
        skipped: true,
        needsAttention,
        shipmentLabel: label,
        reason,
        message: reason,
        meaning,
      },
    };
  }

  const packageChoice = await packageOverridesForPush({
    db,
    organizationId,
    connectionId: secret.connectionId,
    shipment,
    shipmentLabel: label,
    ssService,
    actor,
    recordActivity,
  });
  if (!packageChoice.ok) {
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: false,
      ok: false,
      orderId,
      ssShipmentId: null,
      message: packageChoice.message,
    });
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: packageChoice.message,
      status: 502,
    };
  }
  if (packageChoice.skipReason) {
    const reason = packageChoice.skipReason;
    if (orderId) {
      const retained = skipMapFields(existing);
      await upsertMap({
        db,
        connectionId: secret.connectionId,
        organizationId,
        digitOrderId: orderId,
        digitShipmentId: shipmentId,
        fields: {
          pushStatus: retained.pushStatus,
          lastError: retained.lastError,
          source: existing?.source ?? 'digit',
        },
      });
    }
    const meaning = pushMeaning({
      skipped: true,
      reason,
      ssShipmentId: existing?.ss_shipment_id ?? null,
      shipmentLabel: label,
    });
    const needsAttention = skipNeedsAttention(reason);
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: true,
      ok: true,
      orderId,
      ssShipmentId: existing?.ss_shipment_id ?? null,
      message: meaning,
      quiet: sweep && !needsAttention,
    });
    return {
      ok: true,
      data: {
        shipmentId,
        orderId,
        skipped: true,
        needsAttention,
        shipmentLabel: label,
        reason,
        message: reason,
        meaning,
      },
    };
  }

  const created =
    secret.apiVersion === 'v1'
      ? await createShipments({
          credentials,
          order: digitShipmentToV1Order({
            shipment,
            orgSettings,
            carrierCode: ssService.carrierCode,
            serviceCode: ssService.serviceCode,
            packageSelection: packageChoice.v1Selection,
          }),
        })
      : await createShipments({
          credentials,
          shipments: [
            digitShipmentToShipment({
              shipment,
              shipFrom: orgShipFrom({ organization }),
              orgSettings,
              carrierId: ssService.carrierId,
              serviceCode: ssService.serviceCode,
              packageSelections: packageChoice.overrides,
            }),
          ],
        });
  if (!created.ok) {
    await upsertMap({
      db,
      connectionId: secret.connectionId,
      organizationId,
      digitOrderId: orderId,
      digitShipmentId: shipmentId,
      fields: { pushStatus: 'error', lastError: created.message, source: 'digit' },
    });
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: false,
      ok: false,
      orderId,
      ssShipmentId: null,
      message: created.message,
      detail: created.detail ?? { code: created.code },
    });
    return created;
  }

  const ssShipment = firstCreatedShipment(created.data);
  const createdRecord = normalizeSsRecord(ssShipment?.order || ssShipment);
  const ssShipmentId =
    createdRecord.ssShipmentId || ssShipment?.shipment_id || ssShipment?.shipmentId || null;
  if (!ssShipmentId) {
    await upsertMap({
      db,
      connectionId: secret.connectionId,
      organizationId,
      digitOrderId: orderId,
      digitShipmentId: shipmentId,
      fields: {
        pushStatus: 'error',
        lastError: 'ShipStation did not return a shipment id.',
        source: 'digit',
      },
    });
    const message = 'ShipStation did not return a shipment id.';
    await recordPushActivity({
      db,
      organizationId,
      actor,
      recordActivity,
      skipped: false,
      ok: false,
      orderId,
      ssShipmentId: null,
      message,
    });
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message,
      status: 502,
    };
  }

  await upsertMap({
    db,
    connectionId: secret.connectionId,
    organizationId,
    digitOrderId: orderId,
    digitShipmentId: shipmentId,
    fields: {
      ssShipmentId,
      pushStatus: 'pushed',
      lastError: null,
      source: 'digit',
    },
  });

  const meaning = pushMeaning({
    skipped: false,
    ssShipmentId,
    shipmentLabel: label,
  });
  await recordPushActivity({
    db,
    organizationId,
    actor,
    recordActivity,
    skipped: false,
    ok: true,
    orderId,
    ssShipmentId,
    message: meaning,
  });
  return {
    ok: true,
    data: {
      shipmentId,
      orderId,
      ssShipmentId,
      skipped: false,
      message: `Created ShipStation shipment ${ssShipmentId}.`,
      meaning,
    },
  };
}

export async function downloadShipmentLabel({ env, db, organizationId, shipmentId }) {
  const secret = await liveCredentials({ db, env, organizationId });
  const credentials = credentialsForApi(secret);
  if (!credentials) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: reconnectMessage(secret),
      status: 400,
    };
  }
  const map = await db
    .prepare(
      `SELECT ss_label_id, label_pdf_base64, digit_shipment_id
       FROM shipstation_order_map
       WHERE connection_id = ? AND digit_shipment_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(secret.connectionId, shipmentId)
    .first();
  if (!map) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message:
        'This shipment has not been pushed to ShipStation yet. Push it from the queue, then download the label.',
      status: 400,
    };
  }
  const stored = String(map.label_pdf_base64 || '').replace(/\s+/g, '');
  if (stored) {
    return {
      ok: true,
      data: {
        filename: `shipping-label-${shipmentId}.pdf`,
        contentType: 'application/pdf',
        pdfBase64: stored,
      },
    };
  }
  if (map.ss_label_id && credentials.apiVersion !== 'v1') {
    const fetched = await pdfBase64FromV2Label({ credentials, labelId: map.ss_label_id });
    if (!fetched.ok) return fetched;
    return {
      ok: true,
      data: {
        filename: `shipping-label-${map.ss_label_id}.pdf`,
        contentType: 'application/pdf',
        pdfBase64: fetched.data.pdfBase64,
      },
    };
  }
  return {
    ok: false,
    code: AppErrorCode.VALIDATION_ERROR,
    message:
      'No shipping label is available yet. Buy the label in ShipStation, then pull from ShipStation or wait for the five-minute poll.',
    status: 400,
  };
}

export async function downloadPackingSlip({ env, db, organizationId, orderId }) {
  const fees = await applyMappedShippingFeesToOrder({ env, db, organizationId, orderId });
  if (!fees.ok) return fees;

  const generated = await digitGraphql({
    env,
    query: GENERATE_SALES_ORDER_PDF_QUERY,
    variables: { orderId },
  });
  if (!generated.ok) return generated;

  const url = generated.data?.generateSalesOrderPdf?.url;
  if (typeof url !== 'string' || !url) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Sutton did not return a packing slip URL.',
      status: 502,
    };
  }

  let response;
  try {
    response = await fetch(url);
  } catch {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'The app backend could not fetch the packing slip from Sutton.',
      status: 502,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: `Sutton packing slip download failed (HTTP ${response.status}).`,
      status: 502,
    };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 10 * 1024 * 1024) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'The packing slip exceeds Sutton’s 10MB download limit.',
      status: 400,
    };
  }

  return {
    ok: true,
    data: {
      filename: `packing-slip-${orderId}.pdf`,
      contentType: 'application/pdf',
      pdfBase64: bytesToBase64(buffer),
    },
  };
}

const POLL_PAGE_SIZE = 25;
const MAX_POLL_PAGES = 5;
/** Keeps one scheduled run inside the Digit API rate limit. Remaining shipments wait for the next run. */
const MAX_PUSHES_PER_RUN = 25;

export async function pollOutboundPush({ env, db, organizationId = null, source = 'schedule' }) {
  const { results } = organizationId
    ? { results: [{ organization_id: organizationId }] }
    : await db
        .prepare(`SELECT organization_id FROM shipstation_connection WHERE deleted = 0`)
        .all();

  const actor = source === 'schedule' ? 'schedule' : 'user';
  const pushed = [];
  const skipped = [];
  for (const row of results ?? []) {
    const organizationId = row.organization_id;
    const creds = await liveCredentials({ db, env, organizationId });
    if (!credentialsForApi(creds)) {
      if (creds?.mismatch) {
        await appendActivity({
          db,
          organizationId,
          actor: 'schedule',
          action: 'poll',
          status: 'error',
          message: creds.mismatch,
        });
      }
      continue;
    }
    const orgSettings = await loadOrgSettings({ db, organizationId });
    if (source === 'schedule' && orgSettings.defaultFulfillmentMethod === 'manual') continue;

    let after = null;
    for (let page = 0; page < MAX_POLL_PAGES; page += 1) {
      const listed = await digitGraphql({
        env,
        query: SHIPMENT_LIST_QUERY,
        variables: {
          connection: { first: POLL_PAGE_SIZE, ...(after ? { after } : {}) },
        },
      });
      if (!listed.ok) break;
      const organization = listed.data?.organization ?? null;
      const nodes = listed.data?.shipments?.nodes ?? [];
      for (const shipment of nodes) {
        const result = await pushShipment({
          env,
          db,
          organizationId,
          shipmentId: shipment.id,
          actor,
          recordActivity: true,
          preloaded: { shipment, organization },
          sweep: true,
        });
        if (!result.ok || !result.data) continue;
        if (!result.data.skipped) {
          pushed.push(result.data);
        } else if (result.data.needsAttention) {
          skipped.push({
            shipmentId: result.data.shipmentId,
            shipmentLabel: result.data.shipmentLabel ?? null,
            reason: result.data.reason ?? null,
            nextStep: skipNextStep(result.data.reason),
          });
        }
      }
      if (pushed.length >= MAX_PUSHES_PER_RUN) break;
      if (!listed.data?.shipments?.pageInfo?.hasNextPage) break;
      after = listed.data.shipments.pageInfo.endCursor;
    }
  }
  return { pushed: pushed.length, blocked: skipped.length, blockedShipments: skipped.slice(0, 10) };
}

function notesForCarrierWriteback({ matched, carrierName, existingNotes }) {
  if (matched) return undefined;
  if (existingNotes && String(existingNotes).trim()) return undefined;
  if (carrierName) return `Carrier: ${carrierName}`;
  return undefined;
}

async function applyDigitShipmentWriteback({
  env,
  db,
  organizationId,
  connectionId,
  digitOrderId,
  mappedDigitShipmentId = null,
  trackingNumber,
  carrierName,
  serviceCode,
  shipDate,
  labelId,
  ssShipmentId,
  costAmount,
  costCurrency,
  trackingStatus = null,
}) {
  const shippingStatus = digitShippingStatusFromTrackingStatus(trackingStatus) || 'shipped';
  const loaded = await fetchDigitOrder({ env, orderId: digitOrderId });
  if (!loaded.ok) return loaded;
  const { order } = loaded.data;

  let digitShipment =
    (mappedDigitShipmentId &&
      order.shipments?.find((shipment) => shipment.id === mappedDigitShipmentId)) ||
    order.shipments?.find((shipment) => shipment.shippingStatus !== 'cancelled') ||
    null;
  let digitShipmentId = digitShipment?.id || mappedDigitShipmentId || null;

  const resolved = await resolveDigitCarrier({
    env,
    db,
    organizationId,
    connectionId,
    carrierCode: carrierName,
    carrierName,
    serviceCode,
    actor: 'schedule',
    digitOrderId,
    ssShipmentId,
    recordActivity: true,
  });
  const digitOptionId = resolved.ok ? resolved.data.digitOptionId : null;
  const notes = notesForCarrierWriteback({
    matched: Boolean(digitOptionId),
    carrierName,
    existingNotes: digitShipment?.notes,
  });

  if (!digitShipmentId) {
    const unpacked = (order.packContainers ?? []).filter((container) => !container.shipment);
    let packId = unpacked[0]?.id;
    if (!packId) {
      const createdPack = await digitGraphql({
        env,
        query: CREATE_PACK_CONTAINER_MUTATION,
        variables: {
          input: { orderIds: [digitOrderId], container: 'package' },
        },
      });
      if (!createdPack.ok) return createdPack;
      packId = createdPack.data?.createPackContainer?.packContainer?.id;
    }
    if (!packId) {
      return {
        ok: false,
        code: AppErrorCode.UPSTREAM_ERROR,
        message: 'Could not create a pack container for writeback.',
        status: 502,
      };
    }
    const createdShipment = await digitGraphql({
      env,
      query: CREATE_SHIPMENT_MUTATION,
      variables: {
        input: {
          packContainers: [packId],
          shipmentType: 'carrier',
          shippingStatus,
          trackingNumber: trackingNumber || undefined,
          notes,
          ...(digitOptionId ? { shippingCarrierFieldId: digitOptionId } : {}),
        },
      },
    });
    if (!createdShipment.ok) {
      await logSuttonUpdate({
        db,
        organizationId,
        actor: 'schedule',
        verb: 'Created',
        kind: 'shipment',
        digitOrderId,
        ok: false,
        message: createdShipment.message,
      });
      return createdShipment;
    }
    digitShipmentId = createdShipment.data?.createShipment?.shipment?.id;
    await logSuttonUpdate({
      db,
      organizationId,
      actor: 'schedule',
      verb: 'Created',
      kind: 'shipment',
      digitOrderId,
      changes: [
        `shipping status ${shippingStatus}`,
        ...(digitOptionId ? ['shipping carrier'] : []),
      ],
    });
  } else {
    const updated = await digitGraphql({
      env,
      query: UPDATE_SHIPMENT_MUTATION,
      variables: {
        input: {
          shipmentId: digitShipmentId,
          shippingStatus,
          trackingNumber: trackingNumber || undefined,
          ...(notes !== undefined ? { notes } : {}),
          dropOffDate: shipDate || undefined,
          ...(digitOptionId ? { shippingCarrierFieldId: digitOptionId } : {}),
        },
      },
    });
    if (!updated.ok) {
      await logSuttonUpdate({
        db,
        organizationId,
        actor: 'schedule',
        kind: 'shipment',
        digitOrderId,
        ok: false,
        message: updated.message,
      });
      return updated;
    }
    await logSuttonUpdate({
      db,
      organizationId,
      actor: 'schedule',
      kind: 'shipment',
      label: digitShipment?.documentNumber || digitShipment?.shippingNumber || null,
      digitOrderId,
      changes: [
        `shipping status ${shippingStatus}`,
        ...(shipDate ? ['drop-off date'] : []),
        ...(digitOptionId ? ['shipping carrier'] : []),
      ],
    });
  }

  await upsertMap({
    db,
    connectionId,
    organizationId,
    digitOrderId,
    digitShipmentId,
    fields: {
      digitShipmentId,
      ssShipmentId,
      ssLabelId: labelId,
      pushStatus: 'shipped',
      lastError: null,
      trackingNumber,
      trackingStatus,
      carrierName,
      shipDate,
      shipmentCostAmount: costAmount,
      shipmentCostCurrency: costCurrency,
      channelsNotified: 1,
    },
  });

  const live = await db
    .prepare(
      `SELECT id FROM shipstation_carrier WHERE connection_id = ? AND deleted = 0 LIMIT 1`,
    )
    .bind(connectionId)
    .first();
  await db
    .prepare(
      `INSERT INTO shipment_label (connection_id, carrier_id) VALUES (?, ?)`,
    )
    .bind(connectionId, live?.id ?? null)
    .run();

  const shippingFees = await shippingFeesForDigitOrder({
    db,
    connectionId,
    digitOrderId,
  });
  const fees = await applyOrderShippingFees({
    env,
    orderId: digitOrderId,
    shippingFees,
    shippingCarrierFieldId: digitOptionId,
  });
  if (!fees.ok || !fees.data?.skipped) {
    await logSuttonUpdate({
      db,
      organizationId,
      actor: 'schedule',
      kind: 'order',
      label: order.documentNumber || order.orderNumber || null,
      digitOrderId,
      ok: fees.ok,
      message: fees.ok ? null : fees.message,
      changes: orderFeeChanges({ shippingFees, shippingCarrierFieldId: digitOptionId }),
    });
  }
  if (!fees.ok) return fees;

  await afterDigitShipped({
    env,
    organizationId,
    order,
    shipment: {
      trackingNumber,
      carrierName,
      shipDate,
      digitShipmentId,
    },
  });

  return { ok: true, data: { digitOrderId, digitShipmentId, trackingNumber } };
}

export async function processSsFulfillment({
  env,
  db,
  organizationId,
  ssShipmentId,
  labelId,
  record: preloaded = null,
}) {
  const secret = await liveCredentials({ db, env, organizationId });
  const credentials = credentialsForApi(secret);
  if (!credentials) {
    return {
      ok: true,
      data: { skipped: true, reason: reconnectMessage(secret) },
    };
  }

  let record = preloaded;
  if (!record && labelId && credentials.apiVersion !== 'v1') {
    const fetched = await getLabel({ credentials, labelId });
    if (fetched.ok) record = fetched.data;
  }
  if (!record && ssShipmentId) {
    const fetched = await getShipment({ credentials, shipmentId: ssShipmentId });
    if (fetched.ok) record = firstCreatedShipment(fetched.data) || fetched.data;
  }

  const normalized = normalizeSsRecord(record);
  const shipmentId = ssShipmentId || normalized.ssShipmentId || null;
  const resolvedLabelId = labelId || normalized.labelId || null;
  const externalId = normalized.externalId || null;

  let map = shipmentId
    ? await mapBySsShipment({ db, connectionId: secret.connectionId, ssShipmentId: shipmentId })
    : null;
  if (!map && externalId) {
    map = await db
      .prepare(
        `SELECT * FROM shipstation_order_map
         WHERE connection_id = ? AND digit_shipment_id = ? AND deleted = 0
         LIMIT 1`,
      )
      .bind(secret.connectionId, externalId)
      .first();
  }
  if (!map && externalId) {
    map = await db
      .prepare(
        `SELECT * FROM shipstation_order_map
         WHERE connection_id = ? AND digit_order_id = ? AND deleted = 0
         LIMIT 1`,
      )
      .bind(secret.connectionId, externalId)
      .first();
  }
  if (!map?.digit_order_id) {
    return { ok: true, data: { skipped: true, reason: 'No Sutton order mapped for this shipment.' } };
  }

  return applyDigitShipmentWriteback({
    env,
    db,
    organizationId,
    connectionId: secret.connectionId,
    digitOrderId: map.digit_order_id,
    mappedDigitShipmentId: map.digit_shipment_id ?? null,
    trackingNumber: normalized.trackingNumber,
    carrierName: normalized.carrierCode,
    serviceCode: normalized.serviceCode,
    shipDate: normalized.shipDate,
    labelId: resolvedLabelId,
    ssShipmentId: shipmentId,
    costAmount: normalized.costAmount,
    costCurrency: normalized.costCurrency,
    trackingStatus: normalized.trackingStatus,
  });
}

async function findItemBySku({ env, sku }) {
  const result = await digitGraphql({
    env,
    query: ITEMS_BY_SEARCH_QUERY,
    variables: { search: sku, connection: { first: 10 } },
  });
  if (!result.ok) return result;
  const nodes = result.data?.items?.nodes ?? [];
  const match = nodes.find((item) => item.sku === sku) || nodes[0] || null;
  return { ok: true, data: match };
}

export async function importSsShipment({ env, db, organizationId, connectionId, shipment: rawShipment }) {
  const shipment = normalizedToImportShipment(normalizeSsRecord(rawShipment));
  const ssShipmentId = shipment.shipment_id;
  if (!ssShipmentId) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'ShipStation shipment is missing an id.',
      status: 400,
    };
  }
  const existing = await mapBySsShipment({ db, connectionId, ssShipmentId });
  if (existing) {
    return { ok: true, data: { digitOrderId: existing.digit_order_id, skipped: true } };
  }

  const companyName = ssCompanyName(shipment);
  const companies = await digitGraphql({
    env,
    query: COMPANIES_SEARCH_QUERY,
    variables: { search: companyName, connection: { first: 10 } },
  });
  if (!companies.ok) return companies;
  let companyId = (companies.data?.companies?.nodes ?? []).find(
    (company) => company.name === companyName,
  )?.id;
  if (!companyId) {
    const created = await digitGraphql({
      env,
      query: CREATE_COMPANY_MUTATION,
      variables: {
        input: {
          name: companyName,
          type: ['customer'],
          kind: 'company',
          billingAddress: ssBillingAddressInput(shipment),
          useBillingAsShipping: false,
        },
      },
    });
    if (!created.ok) return created;
    companyId = created.data?.createCompany?.company?.id;
  }
  if (!companyId) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Could not resolve a Sutton customer for the inbound order.',
      status: 502,
    };
  }

  const location = await digitGraphql({
    env,
    query: CREATE_COMPANY_LOCATION_MUTATION,
    variables: { input: ssShipToLocationInput({ companyId, shipment }) },
  });
  if (!location.ok) return location;
  const shippingAddressId = location.data?.createCompanyLocation?.address?.id;
  if (!shippingAddressId) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Could not create a ship-to address.',
      status: 502,
    };
  }

  const org = await digitGraphql({
    env,
    query: `query ShipStationCurrency { organization { defaultCurrency { code } } }`,
  });
  const currencyCode = org.ok ? org.data?.organization?.defaultCurrency?.code || 'USD' : 'USD';

  const lines = [];
  for (const line of ssLineSkus(shipment)) {
    const item = await findItemBySku({ env, sku: line.sku });
    if (!item.ok) return item;
    if (!item.data) {
      return {
        ok: false,
        code: AppErrorCode.VALIDATION_ERROR,
        message: `No Sutton item matches SKU ${line.sku}.`,
        status: 400,
      };
    }
    const defaultSalesPrice = item.data.defaultSalesPrice;
    const hasShipStationPrice =
      typeof line.unitPrice === 'number' && Number.isFinite(line.unitPrice);
    const hasDefaultSalesPrice =
      defaultSalesPrice?.costAmount != null &&
      Number.isFinite(Number(defaultSalesPrice.costAmount));
    const costAmount = hasShipStationPrice
      ? line.unitPrice
      : hasDefaultSalesPrice
        ? Number(defaultSalesPrice.costAmount)
        : 0;
    const lineCurrencyCode =
      !hasShipStationPrice && hasDefaultSalesPrice
        ? defaultSalesPrice.currency?.code || currencyCode
        : currencyCode;
    lines.push({
      id: item.data.id,
      quantity: line.quantity,
      cost: { currencyCode: lineCurrencyCode, costAmount },
    });
  }
  if (lines.length === 0) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'Inbound shipment has no SKUs that map to Sutton items.',
      status: 400,
    };
  }

  const carrier = await resolveDigitCarrier({
    env,
    db,
    organizationId,
    connectionId,
    carrierCode: shipment.carrier_code,
    serviceCode: shipment.service_code,
    actor: 'schedule',
    ssShipmentId,
    recordActivity: true,
  });
  if (!carrier.ok) return carrier;

  const createdOrder = await digitGraphql({
    env,
    query: CREATE_ORDER_MUTATION,
    variables: {
      input: {
        customerId: companyId,
        shippingAddressId,
        customerReferenceNumber: shipment.shipment_number || ssShipmentId,
        orderStatus: 'unfulfilled',
        ...(carrier.data.digitOptionId
          ? { shippingCarrierFieldId: carrier.data.digitOptionId }
          : {}),
        items: lines,
      },
    },
  });
  if (!createdOrder.ok) {
    await logSuttonUpdate({
      db,
      organizationId,
      actor: 'schedule',
      verb: 'Created',
      kind: 'order',
      ok: false,
      message: createdOrder.message,
    });
    return createdOrder;
  }
  const digitOrderId = createdOrder.data?.createOrder?.order?.id;
  const createdOrderNumber = createdOrder.data?.createOrder?.order?.documentNumber || null;
  if (!digitOrderId) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Sutton did not return an order id.',
      status: 502,
    };
  }

  await upsertMap({
    db,
    connectionId,
    organizationId,
    digitOrderId,
    fields: {
      ssShipmentId,
      source: 'shipstation',
      pushStatus: 'imported',
      lastError: null,
    },
  });
  await logSuttonUpdate({
    db,
    organizationId,
    actor: 'schedule',
    verb: 'Created',
    kind: 'order',
    label: createdOrderNumber,
    digitOrderId,
    changes: ['customer', 'line items', ...(carrier.data.digitOptionId ? ['shipping carrier'] : [])],
  });
  return { ok: true, data: { digitOrderId, ssShipmentId, skipped: false } };
}

const MAX_LABEL_POLLS_PER_RUN = 25;

function firstUsableLabel(data) {
  const labels = Array.isArray(data?.labels) ? data.labels : Array.isArray(data) ? data : [];
  const usable = labels.filter((label) => {
    const status = String(label?.status || '').toLowerCase();
    if (status === 'voided' || status === 'error') return false;
    return Boolean(
      label?.tracking_number ||
        label?.trackingNumber ||
        label?.label_id ||
        label?.labelId,
    );
  });
  return (
    usable.find((label) => String(label.status || '').toLowerCase() === 'completed') ||
    usable[0] ||
    null
  );
}

function fulfillmentReady(normalized) {
  return Boolean(normalized?.trackingNumber || normalized?.labelId);
}

async function lookupSsFulfillmentRecord({ credentials, map }) {
  let record = null;
  let lookupError = null;
  let lookupDetail = null;
  let queried = null;
  if (credentials.apiVersion === 'v1') {
    queried = `GET /orders/${map.ss_shipment_id}`;
    const fetched = await getShipment({ credentials, shipmentId: map.ss_shipment_id });
    if (fetched.ok) record = firstCreatedShipment(fetched.data) || fetched.data;
    else {
      lookupError = fetched.message;
      lookupDetail = fetched.detail ?? { code: fetched.code };
    }
    return { record, lookupError, lookupDetail, queried };
  }

  queried = `GET /v2/labels?shipment_id=${map.ss_shipment_id}`;
  const listed = await listLabels({
    credentials,
    query: new URLSearchParams({
      shipment_id: map.ss_shipment_id,
      page_size: '25',
    }).toString(),
  });
  if (!listed.ok) {
    lookupError = listed.message;
    lookupDetail = listed.detail ?? { code: listed.code };
  }
  let label = listed.ok ? firstUsableLabel(listed.data) : null;
  if (!label && map.digit_shipment_id) {
    queried = `${queried}, then external_shipment_id=${map.digit_shipment_id}`;
    const fallback = await listLabels({
      credentials,
      query: new URLSearchParams({
        external_shipment_id: map.digit_shipment_id,
        page_size: '25',
      }).toString(),
    });
    if (!fallback.ok) {
      lookupError = fallback.message;
      lookupDetail = fallback.detail ?? { code: fallback.code };
    }
    label = fallback.ok ? firstUsableLabel(fallback.data) : null;
  }
  return { record: label, lookupError, lookupDetail, queried };
}

async function refreshObservedPackages({
  env,
  db,
  organizationId,
  connectionId,
  credentials,
  map,
  actor,
  preloadedRecord = null,
  skipFetch = false,
}) {
  if (!map?.ss_shipment_id || !map?.digit_shipment_id) return;
  let record = preloadedRecord;
  if (!record) {
    if (skipFetch) return;
    const fetched = await getShipment({ credentials, shipmentId: map.ss_shipment_id });
    if (!fetched.ok) {
      await appendActivity({
        db,
        organizationId,
        actor,
        action: 'poll',
        status: 'error',
        message: `Could not refresh ShipStation package types for ${map.ss_shipment_id}: ${fetched.message}`,
        digitOrderId: map.digit_order_id,
        ssShipmentId: map.ss_shipment_id,
        detail: fetched.detail ?? { code: fetched.code ?? null },
      });
      return;
    }
    record = firstCreatedShipment(fetched.data) || fetched.data;
  }
  try {
    const packages = pulledPackagesFromRecord(record, credentials.apiVersion);
    if (!packages.length) return;
    const identified = packages.every((pkg) => String(pkg.externalPackageId || '').trim());
    let containerIds = packages
      .map((pkg) => String(pkg.externalPackageId || '').trim())
      .filter(Boolean);
    if (!identified) {
      const loaded = await fetchDigitShipment({ env, shipmentId: map.digit_shipment_id });
      if (!loaded.ok) {
        await appendActivity({
          db,
          organizationId,
          actor,
          action: 'poll',
          status: 'error',
          message: `Could not refresh ShipStation package types for ${map.ss_shipment_id}: ${loaded.message}`,
          digitOrderId: map.digit_order_id,
          ssShipmentId: map.ss_shipment_id,
        });
        return;
      }
      containerIds = (loaded.data?.shipment?.packContainers ?? [])
        .map((container) => String(container?.id || '').trim())
        .filter(Boolean);
    }
    const matches = matchPulledPackages({ containerIds, packages });
    for (const match of matches) {
      const existing = await selectionForContainer({
        db,
        connectionId,
        digitContainerId: match.digitContainerId,
      });
      await saveObservedPackage({
        db,
        connectionId,
        organizationId,
        digitShipmentId: map.digit_shipment_id,
        digitContainerId: match.digitContainerId,
        existing,
        pulled: match.pkg,
      });
    }
  } catch (error) {
    await appendActivity({
      db,
      organizationId,
      actor,
      action: 'poll',
      status: 'error',
      message: `Could not refresh ShipStation package types for ${map.ss_shipment_id}: ${error?.message || 'Package sync failed.'}`,
      digitOrderId: map.digit_order_id,
      ssShipmentId: map.ss_shipment_id,
    });
  }
}

/**
 * Pull labels purchased in the ShipStation UI for Digit-pushed maps that still lack tracking.
 */
export async function pollPendingLabels({ env, db, organizationId = null, actor = 'schedule' }) {
  const { results } = organizationId
    ? { results: [{ organization_id: organizationId }] }
    : await db
        .prepare(`SELECT organization_id FROM shipstation_connection WHERE deleted = 0`)
        .all();

  let labelsPulled = 0;
  let labelCandidates = 0;
  // Surfaced in the Refresh banner so a failed lookup or writeback is not reported as "no labels".
  const labelIssues = [];
  for (const row of results ?? []) {
    const orgId = row.organization_id;
    const secret = await liveCredentials({ db, env, organizationId: orgId });
    const credentials = credentialsForApi(secret);
    if (!credentials) continue;

    const { results: maps } = await db
      .prepare(
        `SELECT digit_order_id, digit_shipment_id, ss_shipment_id
         FROM shipstation_order_map
         WHERE connection_id = ? AND deleted = 0
           AND ss_shipment_id IS NOT NULL AND ss_shipment_id != ''
           AND (ss_label_id IS NULL OR ss_label_id = '')
           AND (tracking_number IS NULL OR tracking_number = '')
           AND IFNULL(push_status, '') NOT IN ('shipped', 'imported')
         ORDER BY id
         LIMIT ?`,
      )
      .bind(secret.connectionId, MAX_LABEL_POLLS_PER_RUN)
      .all();
    labelCandidates += (maps ?? []).length;

    for (const map of maps ?? []) {
      const { record, lookupError, lookupDetail, queried } = await lookupSsFulfillmentRecord({
        credentials,
        map,
      });
      await refreshObservedPackages({
        env,
        db,
        organizationId: orgId,
        connectionId: secret.connectionId,
        credentials,
        map,
        actor,
        preloadedRecord: credentials.apiVersion === 'v1' ? record : null,
        skipFetch: credentials.apiVersion === 'v1' && !record,
      });

      if (lookupError) {
        const message = `Could not read ShipStation labels for ${map.ss_shipment_id}: ${lookupError}`;
        labelIssues.push({ status: 'error', ssShipmentId: map.ss_shipment_id, message });
        await appendActivity({
          db,
          organizationId: orgId,
          actor,
          action: 'poll',
          status: 'error',
          message,
          digitOrderId: map.digit_order_id,
          ssShipmentId: map.ss_shipment_id,
          detail: { queried, ...(lookupDetail ?? {}) },
        });
        continue;
      }
      // No label yet is the normal case between push and label purchase, so the five-minute poll
      // stays quiet. A manual Refresh is a debugging action, so record what was actually queried.
      if (!record) {
        if (actor === 'user') {
          await appendActivity({
            db,
            organizationId: orgId,
            actor,
            action: 'poll',
            status: 'skipped',
            message: `No ShipStation label yet for ${map.ss_shipment_id}.`,
            digitOrderId: map.digit_order_id,
            ssShipmentId: map.ss_shipment_id,
            detail: { queried },
          });
        }
        continue;
      }
      const normalized = normalizeSsRecord(record);
      if (!fulfillmentReady(normalized)) continue;

      // The Worker's API token cannot write shipments: Digit offers READ_SHIPMENT to API tokens
      // but not UPDATE_SHIPMENT, so stage the label here and let the frontend apply it with the
      // operator's session, which carries the app's UPDATE_SHIPMENT permission.
      let result;
      try {
        result = await stageLabelWriteback({
          env,
          db,
          organizationId: orgId,
          connectionId: secret.connectionId,
          map,
          normalized,
        });
      } catch (error) {
        result = {
          ok: false,
          message: error?.message || 'Staging the label threw before it could finish.',
          code: error?.code ?? null,
        };
      }
      if (result.ok) {
        labelsPulled += 1;
        continue;
      }
      const message = `Staging ShipStation label ${normalized.labelId} failed: ${result.message}`;
      labelIssues.push({ status: 'error', ssShipmentId: map.ss_shipment_id, message });
      await appendActivity({
        db,
        organizationId: orgId,
        actor,
        action: 'poll',
        status: 'error',
        message,
        digitOrderId: map.digit_order_id,
        ssShipmentId: map.ss_shipment_id,
        detail: { code: result.code },
      });
    }

    const trackingBudget = MAX_LABEL_POLLS_PER_RUN - (maps ?? []).length;
    if (trackingBudget > 0) {
      const { results: trackingMaps } = await db
        .prepare(
          `SELECT digit_order_id, digit_shipment_id, ss_shipment_id, tracking_status
           FROM shipstation_order_map
           WHERE connection_id = ? AND deleted = 0
             AND ss_shipment_id IS NOT NULL AND ss_shipment_id != ''
             AND (ss_label_id IS NOT NULL AND ss_label_id != ''
               OR tracking_number IS NOT NULL AND tracking_number != '')
             AND IFNULL(tracking_status, '') NOT IN ('delivered', 'voided')
             AND IFNULL(push_status, '') NOT IN ('imported')
           ORDER BY id
           LIMIT ?`,
        )
        .bind(secret.connectionId, trackingBudget)
        .all();

      for (const map of trackingMaps ?? []) {
        const { record, lookupError } = await lookupSsFulfillmentRecord({ credentials, map });
        await refreshObservedPackages({
          env,
          db,
          organizationId: orgId,
          connectionId: secret.connectionId,
          credentials,
          map,
          actor,
          preloadedRecord: credentials.apiVersion === 'v1' ? record : null,
          skipFetch: credentials.apiVersion === 'v1' && !record,
        });
        if (lookupError || !record) continue;
        const normalized = normalizeSsRecord(record);
        const nextStatus = String(normalized.trackingStatus || '').toLowerCase();
        const previousStatus = String(map.tracking_status || '').toLowerCase();
        if (!nextStatus || nextStatus === previousStatus) continue;
        const nextDigit = digitShippingStatusFromSs(normalized);
        const previousDigit = digitShippingStatusFromTrackingStatus(previousStatus);
        await upsertMap({
          db,
          connectionId: secret.connectionId,
          organizationId: orgId,
          digitOrderId: map.digit_order_id,
          digitShipmentId: map.digit_shipment_id,
          fields: {
            trackingStatus: nextStatus,
            trackingNumber: normalized.trackingNumber,
            ...(nextDigit && nextDigit !== previousDigit ? { pushStatus: 'label_ready' } : {}),
          },
        });
        if (nextDigit && nextDigit !== previousDigit) labelsPulled += 1;
      }
    }
  }
  return { labelsPulled, labelCandidates, labelIssues: labelIssues.slice(0, 10) };
}

/**
 * Persist a purchased ShipStation label against the map row and mark it `label_ready`.
 * The Digit shipment itself is updated by the frontend (see `pendingShipmentWritebacks`).
 */
async function stageLabelWriteback({ env, db, organizationId, connectionId, map, normalized }) {
  const resolved = await resolveDigitCarrier({
    env,
    db,
    organizationId,
    connectionId,
    carrierCode: normalized.carrierCode,
    carrierName: normalized.carrierCode,
    serviceCode: normalized.serviceCode,
    actor: 'schedule',
    digitOrderId: map.digit_order_id,
    ssShipmentId: map.ss_shipment_id,
    recordActivity: true,
  });

  await upsertMap({
    db,
    connectionId,
    organizationId,
    digitOrderId: map.digit_order_id,
    digitShipmentId: map.digit_shipment_id,
    fields: {
      ssShipmentId: map.ss_shipment_id,
      ssLabelId: normalized.labelId,
      pushStatus: 'label_ready',
      lastError: null,
      trackingNumber: normalized.trackingNumber,
      trackingStatus: normalized.trackingStatus,
      carrierName: normalized.carrierCode,
      serviceCode: normalized.serviceCode,
      serviceName: resolved.ok ? resolved.data.serviceName : normalized.serviceCode,
      shipDate: normalized.shipDate,
      shipmentCostAmount: normalized.costAmount,
      shipmentCostCurrency: normalized.costCurrency,
    },
  });

  return {
    ok: true,
    data: { digitShipmentId: map.digit_shipment_id, labelId: normalized.labelId },
  };
}

/**
 * Digit shipment updates the frontend still owes, newest staged label first. Returned by
 * `POST /sync/poll` so Refresh can run `updateShipment` with the operator's session.
 */
export async function pendingShipmentWritebacks({ env, db, organizationId }) {
  const secret = await liveCredentials({ db, env, organizationId });
  if (!secret?.connectionId) return [];

  const { results } = await db
    .prepare(
      `SELECT digit_order_id, digit_shipment_id, ss_shipment_id, ss_label_id,
              tracking_number, tracking_status, carrier_name, service_code, service_name, ship_date,
              shipment_cost_amount, shipment_cost_currency
       FROM shipstation_order_map
       WHERE connection_id = ? AND deleted = 0
         AND push_status = 'label_ready'
         AND digit_shipment_id IS NOT NULL AND digit_shipment_id != ''
       ORDER BY id
       LIMIT ?`,
    )
    .bind(secret.connectionId, MAX_LABEL_POLLS_PER_RUN)
    .all();

  const pending = [];
  for (const row of results ?? []) {
    const resolved = await resolveDigitCarrier({
      env,
      db,
      organizationId,
      connectionId: secret.connectionId,
      carrierCode: row.carrier_name,
      carrierName: row.carrier_name,
      serviceCode: row.service_code,
      serviceName: row.service_name,
      actor: 'user',
      digitOrderId: row.digit_order_id,
      ssShipmentId: row.ss_shipment_id,
      recordActivity: false,
    });
    const digitOptionId = resolved.ok ? resolved.data.digitOptionId : null;
    const shippingStatus =
      digitShippingStatusFromTrackingStatus(row.tracking_status) || 'shipped';
    const trackingNote =
      String(row.tracking_status || '').toLowerCase() === 'error'
        ? 'ShipStation tracking status: error.'
        : null;
    const carrierNote =
      notesForCarrierWriteback({
        matched: Boolean(digitOptionId),
        carrierName: row.carrier_name,
        existingNotes: null,
      }) ?? null;
    pending.push({
      digitShipmentId: row.digit_shipment_id,
      digitOrderId: row.digit_order_id,
      ssShipmentId: row.ss_shipment_id,
      labelId: row.ss_label_id,
      trackingNumber: row.tracking_number,
      trackingStatus: row.tracking_status ?? null,
      carrierName: row.carrier_name,
      shipDate: row.ship_date,
      shippingStatus,
      shippingCarrierFieldId: digitOptionId,
      notes: [carrierNote, trackingNote].filter(Boolean).join(' ') || null,
      shippingFees: await shippingFeesForDigitOrder({
        db,
        connectionId: secret.connectionId,
        digitOrderId: row.digit_order_id,
      }),
    });
  }
  return pending;
}

/**
 * Called by the frontend once it has updated the Digit shipment, so the map row stops being
 * offered for writeback and downstream channels get their tracking notification.
 */
export async function completeShipmentWriteback({
  env,
  db,
  organizationId,
  digitShipmentId,
  shipmentLabel = null,
  orderLabel = null,
}) {
  const secret = await liveCredentials({ db, env, organizationId });
  if (!secret?.connectionId) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: reconnectMessage(secret),
      status: 400,
    };
  }

  const map = await db
    .prepare(
      `SELECT * FROM shipstation_order_map
       WHERE connection_id = ? AND digit_shipment_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(secret.connectionId, digitShipmentId)
    .first();
  if (!map) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'No ShipStation mapping for that Sutton shipment.',
      status: 400,
    };
  }

  const alreadyNotified = Number(map.channels_notified) === 1;
  const digitStatus = digitShippingStatusFromTrackingStatus(map.tracking_status);
  const notifyChannels = !alreadyNotified && digitStatus === 'shipped';

  await upsertMap({
    db,
    connectionId: secret.connectionId,
    organizationId,
    digitOrderId: map.digit_order_id,
    digitShipmentId,
    fields: {
      pushStatus: 'shipped',
      lastError: null,
      ...(notifyChannels ? { channelsNotified: 1 } : {}),
    },
  });

  if (notifyChannels) {
    const live = await db
      .prepare(`SELECT id FROM shipstation_carrier WHERE connection_id = ? AND deleted = 0 LIMIT 1`)
      .bind(secret.connectionId)
      .first();
    await db
      .prepare(`INSERT INTO shipment_label (connection_id, carrier_id) VALUES (?, ?)`)
      .bind(secret.connectionId, live?.id ?? null)
      .run();
  }

  const shippingFees = await shippingFeesForDigitOrder({
    db,
    connectionId: secret.connectionId,
    digitOrderId: map.digit_order_id,
  });
  const carrier = await packingSlipCarrierForOrder({
    env,
    db,
    organizationId,
    connectionId: secret.connectionId,
    orderId: map.digit_order_id,
    credentials: credentialsForApi(secret),
  });
  const shippingCarrierFieldId = carrier.shippingCarrierFieldId;
  const shipmentChanges = [
    `shipping status ${digitStatus || 'shipped'}`,
  ];
  if (map.ship_date) shipmentChanges.push('drop-off date');
  if (map.carrier_name || map.service_code) shipmentChanges.push('shipping carrier');
  await logSuttonUpdate({
    db,
    organizationId,
    kind: 'shipment',
    label: shipmentLabel,
    digitOrderId: map.digit_order_id,
    changes: shipmentChanges,
  });

  // A voided label is not a fulfillment. Leave the sales order status alone.
  let loadedOrder = null;
  let orderStatus = null;
  if (digitStatus !== 'cancelled' && map.digit_order_id) {
    const loaded = await fetchDigitOrder({ env, orderId: map.digit_order_id });
    if (!loaded.ok) {
      await logSuttonUpdate({
        db,
        organizationId,
        kind: 'order',
        label: orderLabel,
        digitOrderId: map.digit_order_id,
        ok: false,
        message: loaded.message,
        changes: ['order status'],
      });
      return loaded;
    }
    loadedOrder = loaded.data.order;
    orderStatus = salesOrderStatusAfterLabelReturn({
      shipments: loadedOrder.shipments,
      currentShipmentId: digitShipmentId,
    });
  }

  const fees = await applyOrderShippingFees({
    env,
    orderId: map.digit_order_id,
    shippingFees,
    shippingCarrierFieldId,
    orderStatus,
  });
  if (!fees.ok || !fees.data?.skipped) {
    await logSuttonUpdate({
      db,
      organizationId,
      kind: 'order',
      label: orderLabel,
      digitOrderId: map.digit_order_id,
      ok: fees.ok,
      message: fees.ok ? null : fees.message,
      changes: orderFeeChanges({ shippingFees, shippingCarrierFieldId, orderStatus }),
    });
  }
  if (!fees.ok) return fees;

  await appendActivity({
    db,
    organizationId,
    actor: 'user',
    action: 'poll',
    status: 'success',
    message: `Wrote ShipStation tracking ${map.tracking_status || 'unknown'} for label ${map.ss_label_id} to Sutton (tracking ${map.tracking_number}).`,
    digitOrderId: map.digit_order_id,
    ssShipmentId: map.ss_shipment_id,
  });

  if (notifyChannels && loadedOrder) {
    await afterDigitShipped({
      env,
      organizationId,
      order: loadedOrder,
      shipment: {
        trackingNumber: map.tracking_number,
        carrierName: map.carrier_name,
        shipDate: map.ship_date,
        digitShipmentId,
      },
    });
  }

  return { ok: true, data: { digitShipmentId, trackingNumber: map.tracking_number } };
}

export async function resolveShipmentByExternalId({ env, db, organizationId, externalShipmentId }) {
  const secret = await liveCredentials({ db, env, organizationId });
  const credentials = credentialsForApi(secret);
  if (!credentials) return null;
  return getShipmentByExternalId({ credentials, externalShipmentId });
}
