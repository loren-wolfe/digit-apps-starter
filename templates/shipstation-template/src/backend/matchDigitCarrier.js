/**
 * Map a ShipStation carrier + service onto a Digit shippingCarriers option.
 * Never creates Digit options. Manual D1 maps always win over auto-match.
 */

import { digitGraphql } from './digitGraphql.js';
import { appendActivity } from './activity.js';
import { SHIPPING_CARRIERS_QUERY } from './digitQueries.js';
import {
  buildCarrierMapPayload,
  effectiveCarrierMatch,
  liveOptions,
  resolveSsServiceFromDigitOption,
} from './carrierMatch.js';

export {
  buildCarrierMapPayload,
  canonicalCarrierKey,
  effectiveCarrierMatch,
  findSsCatalogRow,
  matchDigitCarrierOptions,
  mappingKey,
  normalizeCarrierKey,
  resolveSsServiceFromDigitOption,
} from './carrierMatch.js';

export async function fetchDigitShippingCarriers({ env }) {
  let result;
  try {
    result = await digitGraphql({
      env,
      query: SHIPPING_CARRIERS_QUERY,
    });
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'MISSING_CONFIG',
      message: error?.message || 'Could not load Sutton shipping carriers.',
      status: error?.status || 503,
    };
  }
  if (!result.ok) return result;
  const options = result.data?.organizationDynamicFields?.shippingCarriers?.options ?? [];
  return { ok: true, data: liveOptions(options) };
}

export async function lookupSsCarrierRow({ db, connectionId, carrierCode }) {
  if (!connectionId || !carrierCode) return null;
  const code = String(carrierCode).trim();
  return db
    .prepare(
      `SELECT id, shipstation_carrier_id, carrier_code, name
       FROM shipstation_carrier
       WHERE connection_id = ? AND deleted = 0
         AND (
           shipstation_carrier_id = ?
           OR carrier_code = ?
           OR lower(name) = lower(?)
         )
       LIMIT 1`,
    )
    .bind(connectionId, code, code, code)
    .first();
}

async function lookupSsServiceRow({ db, connectionId, carrierRowId, serviceCode }) {
  if (!connectionId || !serviceCode) return null;
  const code = String(serviceCode).trim();
  if (carrierRowId) {
    const scoped = await db
      .prepare(
        `SELECT shipstation_service_code, name
         FROM shipstation_service
         WHERE connection_id = ? AND deleted = 0 AND carrier_id = ?
           AND (shipstation_service_code = ? OR lower(name) = lower(?))
         LIMIT 1`,
      )
      .bind(connectionId, carrierRowId, code, code)
      .first();
    if (scoped) return scoped;
  }
  return db
    .prepare(
      `SELECT shipstation_service_code, name
       FROM shipstation_service
       WHERE connection_id = ? AND deleted = 0
         AND (shipstation_service_code = ? OR lower(name) = lower(?))
       LIMIT 1`,
    )
    .bind(connectionId, code, code)
    .first();
}

async function loadMapRow({ db, connectionId, ssCarrierCode, ssServiceCode = '' }) {
  return db
    .prepare(
      `SELECT ss_carrier_code, ss_service_code, digit_option_id, source
       FROM carrier_digit_map
       WHERE connection_id = ? AND ss_carrier_code = ? AND ss_service_code = ?
       LIMIT 1`,
    )
    .bind(connectionId, ssCarrierCode, ssServiceCode || '')
    .first();
}

function mapRowToMapping(row) {
  if (!row) return null;
  return {
    ssCarrierCode: row.ss_carrier_code,
    ssServiceCode: row.ss_service_code || '',
    digitOptionId: row.digit_option_id,
    source: row.source,
  };
}

async function upsertMapRow({
  db,
  connectionId,
  ssCarrierCode,
  ssServiceCode = '',
  digitOptionId,
  source,
}) {
  await db
    .prepare(
      `INSERT INTO carrier_digit_map
         (connection_id, ss_carrier_code, ss_service_code, digit_option_id, source, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(connection_id, ss_carrier_code, ss_service_code) DO UPDATE SET
         digit_option_id = excluded.digit_option_id,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .bind(connectionId, ssCarrierCode, ssServiceCode || '', digitOptionId, source)
    .run();
}

export async function saveManualCarrierMaps({ db, connectionId, mappings }) {
  for (const mapping of mappings) {
    const ssCarrierCode = String(mapping.ssCarrierCode || '').trim();
    if (!ssCarrierCode) continue;
    const ssServiceCode = String(mapping.ssServiceCode ?? '').trim();
    if (mapping.digitOptionId == null || mapping.digitOptionId === '') {
      await db
        .prepare(
          `DELETE FROM carrier_digit_map
           WHERE connection_id = ? AND ss_carrier_code = ? AND ss_service_code = ?`,
        )
        .bind(connectionId, ssCarrierCode, ssServiceCode)
        .run();
      continue;
    }
    await upsertMapRow({
      db,
      connectionId,
      ssCarrierCode,
      ssServiceCode,
      digitOptionId: String(mapping.digitOptionId),
      source: 'manual',
    });
  }
}

/**
 * Resolve a Digit shipping-carrier option id for a ShipStation carrier + service.
 */
export async function resolveDigitCarrier({
  env,
  db,
  organizationId,
  connectionId,
  carrierCode,
  carrierName,
  serviceCode,
  serviceName,
  actor = 'system',
  digitOrderId = null,
  ssShipmentId = null,
  recordActivity = true,
}) {
  const code = carrierCode ? String(carrierCode).trim() : '';
  const catalog = await lookupSsCarrierRow({ db, connectionId, carrierCode: code });
  const friendly = (carrierName && String(carrierName).trim()) || catalog?.name || null;
  const resolvedCode = catalog?.carrier_code || code || catalog?.shipstation_carrier_id || null;
  const rawService = serviceCode ? String(serviceCode).trim() : '';
  const serviceRow = await lookupSsServiceRow({
    db,
    connectionId,
    carrierRowId: catalog?.id,
    serviceCode: rawService,
  });
  const resolvedService = serviceRow?.shipstation_service_code || rawService || '';
  const resolvedServiceName =
    (serviceName && String(serviceName).trim()) || serviceRow?.name || resolvedService || null;

  if (!resolvedCode && !friendly && !resolvedService) {
    return {
      ok: true,
      data: {
        digitOptionId: null,
        method: null,
        carrierCode: null,
        carrierName: null,
        serviceCode: null,
        serviceName: null,
        digitValue: null,
      },
    };
  }

  const fetched = await fetchDigitShippingCarriers({ env });
  if (!fetched.ok) return fetched;
  const options = fetched.data;

  const serviceMapping =
    connectionId && resolvedCode
      ? mapRowToMapping(
          await loadMapRow({
            db,
            connectionId,
            ssCarrierCode: resolvedCode,
            ssServiceCode: resolvedService,
          }),
        )
      : null;
  const carrierMapping =
    connectionId && resolvedCode
      ? mapRowToMapping(
          await loadMapRow({
            db,
            connectionId,
            ssCarrierCode: resolvedCode,
            ssServiceCode: '',
          }),
        )
      : null;

  const match = effectiveCarrierMatch({
    carrierCode: resolvedCode,
    carrierName: friendly,
    serviceCode: resolvedService,
    serviceName: resolvedServiceName,
    options,
    serviceMapping,
    carrierMapping,
  });

  if (
    match.matchSource === 'fuzzy' &&
    match.digitOptionId &&
    connectionId &&
    resolvedCode &&
    resolvedService &&
    !serviceMapping
  ) {
    await upsertMapRow({
      db,
      connectionId,
      ssCarrierCode: resolvedCode,
      ssServiceCode: resolvedService,
      digitOptionId: match.digitOptionId,
      source: 'fuzzy',
    });
  }

  if (match.digitOptionId) {
    return {
      ok: true,
      data: {
        digitOptionId: match.digitOptionId,
        method: match.matchSource,
        carrierCode: resolvedCode,
        carrierName: friendly,
        serviceCode: resolvedService || null,
        serviceName: resolvedServiceName,
        digitValue: match.digitValue,
      },
    };
  }

  if (recordActivity && organizationId) {
    await appendActivity({
      db,
      organizationId,
      actor,
      action: 'carrier_unmapped',
      status: 'warning',
      digitOrderId,
      ssShipmentId,
      message: `ShipStation ${resolvedServiceName || resolvedService || resolvedCode || friendly} did not match a Sutton shipping carrier. Map it in carrier settings.`,
      detail: {
        carrierCode: resolvedCode,
        carrierName: friendly,
        serviceCode: resolvedService || null,
        serviceName: resolvedServiceName,
      },
    });
  }

  return {
    ok: true,
    data: {
      digitOptionId: null,
      method: null,
      carrierCode: resolvedCode,
      carrierName: friendly,
      serviceCode: resolvedService || null,
      serviceName: resolvedServiceName,
      digitValue: null,
    },
  };
}

export async function loadCarrierMapPayload({ env, db, organizationId, connectionId }) {
  void organizationId;
  const fetched = await fetchDigitShippingCarriers({ env });
  const digitCarriers = fetched.ok
    ? fetched.data.map((option) => ({ id: option.id, value: option.value }))
    : [];

  let ssCarriers = [];
  let mappings = [];
  let pulledServices = [];
  if (connectionId) {
    const catalog = await loadSsCatalogAndMaps({ db, connectionId });
    ssCarriers = catalog.ssCarriers;
    mappings = catalog.mappings;

    const { results: pulledRows } = await db
      .prepare(
        `SELECT DISTINCT carrier_name, service_code, service_name
         FROM shipstation_order_map
         WHERE connection_id = ? AND deleted = 0
           AND (
             (carrier_name IS NOT NULL AND trim(carrier_name) != '')
             OR (service_code IS NOT NULL AND trim(service_code) != '')
           )`,
      )
      .bind(connectionId)
      .all();
    pulledServices = (pulledRows ?? []).map((row) => ({
      carrierCode: row.carrier_name,
      serviceCode: row.service_code,
      serviceName: row.service_name,
    }));
  }

  return buildCarrierMapPayload({
    digitCarriers,
    ssCarriers,
    mappings,
    pulledServices,
    digitCarriersError: fetched.ok
      ? null
      : fetched.message || 'Could not load Sutton shipping carriers.',
  });
}

/**
 * Load ShipStation catalog + Digit maps for outbound push reverse-lookup.
 */
export async function loadSsCatalogAndMaps({ db, connectionId }) {
  if (!connectionId) {
    return { ssCarriers: [], mappings: [] };
  }

  const { results: carrierRows } = await db
    .prepare(
      `SELECT id, carrier_code, name, shipstation_carrier_id
       FROM shipstation_carrier
       WHERE connection_id = ? AND deleted = 0
       ORDER BY name COLLATE NOCASE, id`,
    )
    .bind(connectionId)
    .all();

  const { results: serviceRows } = await db
    .prepare(
      `SELECT carrier_id, shipstation_service_code, name
       FROM shipstation_service
       WHERE connection_id = ? AND deleted = 0
       ORDER BY name COLLATE NOCASE, id`,
    )
    .bind(connectionId)
    .all();
  const servicesByCarrier = new Map();
  for (const service of serviceRows ?? []) {
    const list = servicesByCarrier.get(service.carrier_id) ?? [];
    list.push({
      serviceCode: service.shipstation_service_code,
      name: service.name,
    });
    servicesByCarrier.set(service.carrier_id, list);
  }

  const ssCarriers = (carrierRows ?? []).map((row) => ({
    carrierCode: row.carrier_code,
    name: row.name,
    shipstationCarrierId: row.shipstation_carrier_id,
    services: servicesByCarrier.get(row.id) ?? [],
  }));

  const { results: mapRows } = await db
    .prepare(
      `SELECT ss_carrier_code, ss_service_code, digit_option_id, source
       FROM carrier_digit_map
       WHERE connection_id = ?`,
    )
    .bind(connectionId)
    .all();
  const mappings = (mapRows ?? []).map((row) => ({
    ssCarrierCode: row.ss_carrier_code,
    ssServiceCode: row.ss_service_code || '',
    digitOptionId: row.digit_option_id,
    source: row.source,
  }));

  return { ssCarriers, mappings };
}

/**
 * Resolve the ShipStation carrier + service for a Digit shipment's shipping carrier.
 */
export async function resolveSsServiceForDigitShipment({
  db,
  connectionId,
  digitOptionId,
  digitValue = null,
}) {
  const { ssCarriers, mappings } = await loadSsCatalogAndMaps({ db, connectionId });
  return resolveSsServiceFromDigitOption({
    digitOptionId,
    digitValue,
    mappings,
    ssCarriers,
  });
}
