/**
 * ShipStation connection, org settings, and carrier catalog (D1).
 * Returns a Response when the request matches; otherwise null.
 *
 * Credentials are org-level Digit app secrets (never pasted into this app, never
 * selected into JSON). `api_key_encrypted` only holds legacy pasted keys (V2).
 */

import { AppErrorCode, parseJsonResponse, requiredString } from '@heysutton/sdk';
import { err, ok, requireEnv } from '@heysutton/sdk-server';

import { FULFILLMENT_METHODS, normalizeFulfillmentMethod } from './eligibility.js';
import { appendActivity, pacificDate, truncateMessage } from './activity.js';
import { catalogPullMessage, syncConnectionPackageCatalog } from './packageCatalog.js';
import { loadShipStationApiKey, resolveShipStationCredentials } from './runtimeConfig.js';
import {
  listCarrierServices,
  listAllCarriers,
} from './shipstation.js';
import { credentialsForApi, liveCredentials, publicConnection, loadOrgSettings } from './sync.js';
import { loadCarrierMapPayload, saveManualCarrierMaps } from './matchDigitCarrier.js';
import { MAX_SOURCE_FILTER_KEYS } from './sourceFilter.js';

/** Request body `sourceFilter` → `{ ok, value }` or `{ ok: false, message }`. */
function parseSourceFilterBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'sourceFilter must be an object with enabled and keys.' };
  }
  const enabled = Boolean(raw.enabled);
  const rawKeys = raw.keys ?? [];
  if (!Array.isArray(rawKeys) || rawKeys.some((key) => typeof key !== 'string' || !key.trim())) {
    return { ok: false, message: 'sourceFilter.keys must be an array of non-empty strings.' };
  }
  const keys = [...new Set(rawKeys.map((key) => key.trim()))];
  if (keys.length > MAX_SOURCE_FILTER_KEYS) {
    return { ok: false, message: `Select at most ${MAX_SOURCE_FILTER_KEYS} sources.` };
  }
  if (enabled && keys.length === 0) {
    return {
      ok: false,
      message: 'Select at least one source, or turn off the source filter to route every source.',
    };
  }
  return { ok: true, value: { enabled, keys } };
}

async function liveConnection({ db, organizationId }) {
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

function requireOrganizationId(url) {
  const organizationId = (url.searchParams.get('organizationId') || '').trim();
  if (!organizationId) {
    return {
      error: err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'organizationId is required.',
        status: 400,
      }),
    };
  }
  return { organizationId };
}

function normalizeCarrierList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.carriers)) return data.carriers;
  return [];
}

function normalizeServiceList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.services)) return data.services;
  return [];
}

function carrierIdentity(carrier) {
  return String(
    carrier.carrier_id ??
      carrier.carrierId ??
      carrier.code ??
      carrier.id ??
      carrier.shippingProviderId ??
      '',
  ).trim();
}

async function upsertCarrierServices({ db, connectionId, carrierRowId, services }) {
  const { results } = await db
    .prepare(
      `SELECT id, shipstation_service_code, name, deleted
       FROM shipstation_service
       WHERE connection_id = ? AND carrier_id = ?`,
    )
    .bind(connectionId, carrierRowId)
    .all();
  const existing = new Map(
    (results ?? []).map((row) => [String(row.shipstation_service_code), row]),
  );
  const seen = new Set();
  for (const service of services) {
    const code = String(service.service_code ?? service.serviceCode ?? service.code ?? '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const serviceName = String(service.name ?? code);
    const current = existing.get(code);
    if (current) {
      if (current.deleted || current.name !== serviceName) {
        await db
          .prepare(
            `UPDATE shipstation_service
             SET name = ?, deleted = 0, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .bind(serviceName, current.id)
          .run();
      }
    } else {
      await db
        .prepare(
          `INSERT INTO shipstation_service
             (connection_id, carrier_id, shipstation_service_code, name, deleted)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .bind(connectionId, carrierRowId, code, serviceName)
        .run();
    }
  }
  for (const [code, row] of existing) {
    if (seen.has(code) || row.deleted) continue;
    await db
      .prepare(
        `UPDATE shipstation_service
         SET deleted = 1, updated_at = datetime('now')
         WHERE id = ? AND deleted = 0`,
      )
      .bind(row.id)
      .run();
  }
}

async function syncCarriers({ db, connectionId, credentials, carriers, pruneMissing = true }) {
  const { results: existingRows } = await db
    .prepare(
      `SELECT id, shipstation_carrier_id, deleted
       FROM shipstation_carrier
       WHERE connection_id = ?`,
    )
    .bind(connectionId)
    .all();
  const existingByShipstationId = new Map();
  for (const row of existingRows ?? []) {
    const key = String(row.shipstation_carrier_id || '');
    const current = existingByShipstationId.get(key);
    if (!current || (current.deleted && !row.deleted)) existingByShipstationId.set(key, row);
  }

  const seen = new Set();
  const added = [];
  for (const carrier of carriers) {
    const shipstationCarrierId = carrierIdentity(carrier);
    if (!shipstationCarrierId || seen.has(shipstationCarrierId)) continue;
    seen.add(shipstationCarrierId);
    const name = String(
      carrier.friendly_name ?? carrier.name ?? carrier.nickname ?? shipstationCarrierId,
    );
    const carrierCode = carrier.carrier_code ?? carrier.carrierCode ?? carrier.code ?? null;
    const existing = existingByShipstationId.get(shipstationCarrierId);
    const isNew = !existing || Boolean(existing.deleted);
    let carrierRowId = existing?.id;
    if (isNew) {
      added.push({
        name,
        carrierCode: carrierCode || null,
        shipstationCarrierId,
      });
    }
    if (carrierRowId) {
      await db
        .prepare(
          `UPDATE shipstation_carrier
           SET carrier_code = ?, name = ?, deleted = 0, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .bind(carrierCode, name, carrierRowId)
        .run();
    } else {
      const inserted = await db
        .prepare(
          `INSERT INTO shipstation_carrier
             (connection_id, shipstation_carrier_id, carrier_code, name, deleted)
           VALUES (?, ?, ?, ?, 0)
           RETURNING id`,
        )
        .bind(connectionId, shipstationCarrierId, carrierCode, name)
        .first();
      carrierRowId = inserted.id;
    }

    let services = normalizeServiceList(carrier.services);
    if (services.length === 0 && !existing) {
      const listed = await listCarrierServices({
        credentials,
        carrierId: shipstationCarrierId,
        carrierCode: carrierCode || shipstationCarrierId,
      });
      if (listed.ok) services = normalizeServiceList(listed.data);
    }
    if (services.length > 0) {
      await upsertCarrierServices({ db, connectionId, carrierRowId, services });
    }
  }

  for (const [shipstationCarrierId, row] of existingByShipstationId) {
    if (!pruneMissing || seen.has(shipstationCarrierId) || row.deleted) continue;
    await db
      .prepare(
        `UPDATE shipstation_carrier
         SET deleted = 1, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(row.id)
      .run();
    await db
      .prepare(
        `UPDATE shipstation_service
         SET deleted = 1, updated_at = datetime('now')
         WHERE carrier_id = ? AND deleted = 0`,
      )
      .bind(row.id)
      .run();
  }
  return added;
}

const carrierRefreshInflight = new Map();

/** Re-pull the connected carrier catalog from ShipStation and upsert it. */
export async function refreshCarriers({ db, connectionId, credentials, timeoutMs }) {
  const key = String(connectionId);
  const pending = carrierRefreshInflight.get(key);
  if (pending) return pending;
  const job = (async () => {
    const listed = await listAllCarriers({ credentials, timeoutMs });
    if (!listed.ok) {
      try {
        const org = await db
          .prepare(`SELECT organization_id FROM shipstation_connection WHERE id = ?`)
          .bind(connectionId)
          .first();
        if (org?.organization_id) {
          const message = truncateMessage(
            `Could not pull carriers from ShipStation: ${listed.message || 'ShipStation did not return carriers.'}`,
          );
          const recent = await db
            .prepare(
              `SELECT id FROM activity_log
               WHERE organization_id = ? AND action = 'catalog_pull' AND status = 'error'
                 AND message = ? AND created_at > datetime('now', '-15 minutes')
               LIMIT 1`,
            )
            .bind(org.organization_id, message)
            .first();
          if (!recent) {
            await appendActivity({
              db,
              organizationId: org.organization_id,
              actor: 'user',
              action: 'catalog_pull',
              status: 'error',
              message,
              detail: listed.detail || null,
            });
          }
        }
      } catch {
        // Return the ShipStation error even if the activity write fails.
      }
      return listed;
    }
    const added = await syncCarriers({
      db,
      connectionId,
      credentials,
      carriers: normalizeCarrierList(listed.data),
      pruneMissing: !listed.truncated,
    });
    if (added.length > 0) {
      const org = await db
        .prepare(`SELECT organization_id FROM shipstation_connection WHERE id = ?`)
        .bind(connectionId)
        .first();
      if (org?.organization_id) {
        await appendActivity({
          db,
          organizationId: org.organization_id,
          actor: 'user',
          action: 'catalog_pull',
          status: 'success',
          message: catalogPullMessage({ kind: 'carriers', items: added }),
          detail: { carriers: added.slice(0, 40) },
        });
      }
    }
    return { ok: true, added };
  })().finally(() => {
    if (carrierRefreshInflight.get(key) === job) carrierRefreshInflight.delete(key);
  });
  carrierRefreshInflight.set(key, job);
  return job;
}

async function carrierCount({ db, connectionId }) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM shipstation_carrier
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .first();
  return Number(row?.count ?? 0);
}

async function loadCarriers({ db, connectionId }) {
  const { results: carrierRows } = await db
    .prepare(
      `SELECT id, shipstation_carrier_id, carrier_code, name
       FROM shipstation_carrier
       WHERE connection_id = ? AND deleted = 0
       ORDER BY name COLLATE NOCASE, id`,
    )
    .bind(connectionId)
    .all();

  const { results: serviceRows } = await db
    .prepare(
      `SELECT id, carrier_id, shipstation_service_code, name
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
      id: service.id,
      carrierId: service.carrier_id,
      serviceCode: service.shipstation_service_code,
      name: service.name,
    });
    servicesByCarrier.set(service.carrier_id, list);
  }

  return (carrierRows ?? []).map((carrier) => ({
    id: carrier.id,
    shipstationCarrierId: carrier.shipstation_carrier_id,
    carrierCode: carrier.carrier_code,
    name: carrier.name,
    services: servicesByCarrier.get(carrier.id) ?? [],
  }));
}

async function retireConnectionLocal({ db, connectionId }) {
  await db
    .prepare(
      `UPDATE shipstation_webhook SET deleted = 1
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .run();
  await db
    .prepare(
      `UPDATE shipstation_service SET deleted = 1, updated_at = datetime('now')
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .run();
  await db
    .prepare(
      `UPDATE shipstation_carrier SET deleted = 1, updated_at = datetime('now')
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .run();
  await db
    .prepare(
      `UPDATE package_catalog SET deleted = 1, updated_at = datetime('now')
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .run();
  await db
    .prepare(
      `UPDATE shipstation_connection
       SET deleted = 1, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(connectionId)
    .run();
}

/**
 * Soft-delete a live connection.
 */
async function retireConnection({ db, connectionId }) {
  await retireConnectionLocal({ db, connectionId });
}

/**
 * @returns {Promise<Response | null>}
 */
export async function handleConnection({ request, env, path, method }) {
  const db = requireEnv({ env, key: 'SHIPSTATION_DB' });
  const url = new URL(request.url);

  if (method === 'GET' && path === '/connection') {
    const org = requireOrganizationId(url);
    if (org.error) return org.error;
    const row = await liveConnection({ db, organizationId: org.organizationId });
    if (!row) {
      return ok({ data: { connected: false, organizationId: org.organizationId } });
    }
    const count = await carrierCount({ db, connectionId: row.id });
    const resolved = await resolveShipStationCredentials({ env, db });
    const creds = resolved
      ? await liveCredentials({ db, env, organizationId: org.organizationId })
      : null;
    const credentialsMissing = !resolved;
    return ok({
      data: publicConnection(row, {
        carrierCount: count,
        apiVersion: row.api_version || 'v2',
        ...(creds?.mismatch ? { mismatch: creds.mismatch } : {}),
        ...(credentialsMissing ? { credentialsMissing: true, staleConnection: true } : {}),
      }),
    });
  }

  if (method === 'GET' && path === '/carriers') {
    const org = requireOrganizationId(url);
    if (org.error) return org.error;
    const row = await liveConnection({ db, organizationId: org.organizationId });
    if (!row) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'Connect a ShipStation account first.',
        status: 400,
      });
    }
    return ok({ data: { carriers: await loadCarriers({ db, connectionId: row.id }) } });
  }

  if (method === 'GET' && path === '/org-settings') {
    const org = requireOrganizationId(url);
    if (org.error) return org.error;
    const organizationId = org.organizationId;
    const settings = await loadOrgSettings({ db, organizationId });
    const row = await liveConnection({ db, organizationId });
    if (row) {
      const secret = await liveCredentials({ db, env, organizationId });
      const credentials = credentialsForApi(secret);
      if (credentials) {
        await refreshCarriers({
          db,
          connectionId: row.id,
          credentials,
          timeoutMs: 12000,
        });
      }
    }
    const carrierPayload = await loadCarrierMapPayload({
      env,
      db,
      organizationId,
      connectionId: row?.id ?? null,
    });
    return ok({ data: { ...settings, ...carrierPayload } });
  }

  if (method === 'POST' && path === '/connection') {
    const parsed = await parseJsonResponse({
      value: request.json(),
      fields: {
        organizationId: (obj) => requiredString({ obj, key: 'organizationId' }),
      },
    });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const { organizationId } = parsed.value;

    const credentials = await resolveShipStationCredentials({ env, db });
    if (!credentials) {
      return err({
        code: AppErrorCode.MISSING_CONFIG,
        message:
          'No ShipStation API key is configured. Add SHIPSTATION_API_KEY to this app’s secrets in Sutton (and SHIPSTATION_API_SECRET for V1), then try again.',
        status: 503,
      });
    }

    const existing = await liveConnection({ db, organizationId });
    if (existing) {
      // Stale row after secrets were removed/restored, or UI showed Connect while still linked.
      // Retire the old connection so Connect can succeed without a separate Disconnect click.
      await retireConnection({
        db,
        connectionId: existing.id,
      });
      await appendActivity({
        db,
        organizationId,
        actor: 'user',
        action: 'disconnect',
        status: 'success',
        message:
          'Replaced the previous ShipStation connection before reconnecting with current secrets.',
        detail: { previousConnectionId: existing.id },
      });
    }

    const listed = await listAllCarriers({ credentials });
    if (!listed.ok) {
      return err({
        code: listed.code,
        message: listed.message,
        status: listed.status,
      });
    }

    let inserted;
    try {
      inserted = await db
        .prepare(
          `INSERT INTO shipstation_connection (organization_id, api_key_encrypted, api_version, deleted)
           VALUES (?, '', ?, 0)
           RETURNING id, organization_id, api_version, created_at, updated_at`,
        )
        .bind(organizationId, credentials.apiVersion)
        .first();
    } catch {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message:
          'This organization already has a ShipStation account connected. Disconnect it first to reconnect.',
        status: 409,
      });
    }

    await syncCarriers({
      db,
      connectionId: inserted.id,
      credentials,
      carriers: normalizeCarrierList(listed.data),
      pruneMissing: !listed.truncated,
    });

    try {
      await syncConnectionPackageCatalog({
        db,
        connectionId: inserted.id,
        organizationId,
        credentials,
        actor: 'user',
        pulledOn: pacificDate(new Date()),
      });
    } catch {
      // Connect still succeeds. The nightly job retries the catalog.
    }

    const count = await carrierCount({ db, connectionId: inserted.id });
    const versionLabel = credentials.apiVersion === 'v1' ? 'V1' : 'V2';
    await appendActivity({
      db,
      organizationId,
      actor: 'user',
      action: 'connect',
      status: 'success',
      message: `Connected ShipStation ${versionLabel} and synced ${count} carrier(s). Push from the queue, then buy labels in ShipStation.`,
      detail: { carrierCount: count, apiVersion: credentials.apiVersion },
    });
    return ok({
      data: publicConnection(inserted, {
        carrierCount: count,
        apiVersion: inserted.api_version || credentials.apiVersion,
      }),
      status: 201,
    });
  }

  if (method === 'PATCH' && path === '/org-settings') {
    const parsed = await parseJsonResponse({ value: request.json() });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const body = parsed.value;
    const organizationIdResult = requiredString({ obj: body, key: 'organizationId' });
    if (!organizationIdResult.ok) {
      return err({
        code: organizationIdResult.error.code,
        message: organizationIdResult.error.message,
        status: 400,
      });
    }
    const organizationId = organizationIdResult.value;
    const current = await loadOrgSettings({ db, organizationId });

    let defaultFulfillmentMethod = current.defaultFulfillmentMethod;
    if (body.defaultFulfillmentMethod !== undefined && body.defaultFulfillmentMethod !== null) {
      defaultFulfillmentMethod = normalizeFulfillmentMethod(String(body.defaultFulfillmentMethod));
    }

    let defaultWeightOz = current.defaultWeightOz;
    if (body.defaultWeightOz !== undefined) {
      const n = Number(body.defaultWeightOz);
      if (!Number.isFinite(n) || n <= 0) {
        return err({
          code: AppErrorCode.VALIDATION_ERROR,
          message: 'defaultWeightOz must be a number greater than 0.',
          status: 400,
        });
      }
      defaultWeightOz = n;
    }

    if (!FULFILLMENT_METHODS.has(defaultFulfillmentMethod)) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'defaultFulfillmentMethod must be scheduled or manual.',
        status: 400,
      });
    }

    let sourceFilter = current.sourceFilter;
    if (body.sourceFilter !== undefined && body.sourceFilter !== null) {
      const parsedFilter = parseSourceFilterBody(body.sourceFilter);
      if (!parsedFilter.ok) {
        return err({
          code: AppErrorCode.VALIDATION_ERROR,
          message: parsedFilter.message,
          status: 400,
        });
      }
      sourceFilter = parsedFilter.value;
    }

    await db
      .prepare(
        `INSERT INTO org_settings (
           organization_id, default_fulfillment_method, sync_mode, push_when, lane_tag_id,
           default_weight_oz, default_length_in, default_width_in, default_height_in, rate_strategy,
           source_filter_enabled, source_filter_keys
         )
         VALUES (?, ?, 'digit_to_ss', 'fully_packed', NULL, ?, NULL, NULL, NULL, 'cheapest', ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           default_fulfillment_method = excluded.default_fulfillment_method,
           default_weight_oz = excluded.default_weight_oz,
           source_filter_enabled = excluded.source_filter_enabled,
           source_filter_keys = excluded.source_filter_keys,
           updated_at = datetime('now')`,
      )
      .bind(
        organizationId,
        defaultFulfillmentMethod,
        defaultWeightOz,
        sourceFilter.enabled ? 1 : 0,
        JSON.stringify(sourceFilter.keys),
      )
      .run();

    if (Array.isArray(body.mappings)) {
      const connectionRow = await liveConnection({ db, organizationId });
      if (connectionRow) {
        await saveManualCarrierMaps({
          db,
          connectionId: connectionRow.id,
          mappings: body.mappings,
        });
      }
    }

    await appendActivity({
      db,
      organizationId,
      actor: 'user',
      action: 'settings',
      status: 'success',
      message: `Saved settings (push ${defaultFulfillmentMethod}, default weight ${defaultWeightOz} oz, ${
        sourceFilter.enabled
          ? `routing ${sourceFilter.keys.length} selected source(s)`
          : 'routing every source'
      }).`,
      detail: sourceFilter.enabled ? { sourceFilterKeys: sourceFilter.keys } : null,
    });
    const carrierPayload = await loadCarrierMapPayload({
      env,
      db,
      organizationId,
      connectionId: (await liveConnection({ db, organizationId }))?.id ?? null,
    });
    return ok({
      data: { ...(await loadOrgSettings({ db, organizationId })), ...carrierPayload },
    });
  }

  if (method === 'DELETE' && path === '/connection') {
    const parsed = await parseJsonResponse({
      value: request.json(),
      fields: {
        organizationId: (obj) => requiredString({ obj, key: 'organizationId' }),
      },
    });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const { organizationId } = parsed.value;
    const row = await liveConnection({ db, organizationId });
    if (!row) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'No ShipStation account is connected.',
        status: 400,
      });
    }

    await retireConnection({ db, connectionId: row.id });

    await appendActivity({
      db,
      organizationId,
      actor: 'user',
      action: 'disconnect',
      status: 'success',
      message:
        'Disconnected ShipStation. Order maps and activity history remain. Reconnect to push again.',
    });

    return ok({ data: { connected: false, organizationId } });
  }

  return null;
}

// Re-export for tests / callers that imported liveConnection from here historically.
export { liveCredentials, loadShipStationApiKey };
