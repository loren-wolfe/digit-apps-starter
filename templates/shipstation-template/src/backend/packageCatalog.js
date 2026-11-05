/**
 * Normalize ShipStation package-type catalogs (V2 custom, V2 carrier, V1 carrier)
 * into one shape the queue and push path share.
 */

import { appendActivity, isActivityPruneWindow, pacificDate } from './activity.js';

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeDimensionUnit(unit) {
  const token = String(unit || '')
    .trim()
    .toLowerCase();
  if (!token) return 'inch';
  if (token.startsWith('cm') || token.startsWith('cent')) return 'centimeter';
  if (token.startsWith('in')) return 'inch';
  return 'inch';
}

export function normalizeWeightUnit(unit) {
  const token = String(unit || '')
    .trim()
    .toLowerCase();
  if (token.startsWith('lb') || token.startsWith('pound')) return 'pound';
  if (token.startsWith('kg') || token.startsWith('kilogram')) return 'kilogram';
  if (token.startsWith('g')) return 'gram';
  if (token.startsWith('oz') || token.startsWith('ounce')) return 'ounce';
  return token || null;
}

export function normalizePackageDimensions(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const length = positiveNumber(raw.length);
  const width = positiveNumber(raw.width);
  const height = positiveNumber(raw.height);
  if (length == null || width == null || height == null) return null;
  return {
    length,
    width,
    height,
    unit: normalizeDimensionUnit(raw.unit || raw.units),
  };
}

export function normalizePackageWeight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = positiveNumber(raw.value);
  if (value == null) return null;
  const unit = normalizeWeightUnit(raw.unit || raw.units);
  if (!unit) return null;
  return { value, unit };
}

export function normalizeListedPackage(raw, { source, carrierId = null, carrierCode = null }) {
  const packageCode = String(raw?.package_code || raw?.packageCode || raw?.code || '').trim();
  if (!packageCode || packageCode.length > 50) return null;
  const packageId = String(raw?.package_id || raw?.packageId || '').trim() || null;
  return {
    source,
    packageCode,
    packageId,
    name: String(raw?.name || packageCode).trim() || packageCode,
    description: raw?.description ? String(raw.description) : null,
    carrierId: carrierId || null,
    carrierCode: String(raw?.carrierCode || carrierCode || '').trim() || null,
    dimensions: normalizePackageDimensions(raw?.dimensions),
  };
}

function listedPackages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.packages)) return data.packages;
  return [];
}

export function normalizePackageList(data, context) {
  return listedPackages(data)
    .map((raw) => normalizeListedPackage(raw, context))
    .filter(Boolean);
}

export function packageSeenKey(pkg) {
  const source = pkg?.source === 'custom' ? 'custom' : 'carrier';
  const carrier = String(
    pkg?.carrierId || pkg?.ssCarrierId || pkg?.carrierCode || pkg?.ssCarrierCode || '',
  ).trim();
  const code = String(pkg?.packageCode || pkg?.package_code || '').trim();
  if (!code) return '';
  return `${source}\0${carrier}\0${code}`;
}

/** Packages in this pull whose code this connection has not already recorded. */
export function unseenPackages(knownKeys, packages) {
  const seen = new Set(knownKeys);
  const added = [];
  for (const pkg of packages ?? []) {
    const key = packageSeenKey(pkg);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(pkg);
  }
  return added;
}

/** Carrier codes the stored catalog cannot resolve. V2 package lists need those ids. */
export function unresolvedCarrierCodes({ carrierCodes = [], storedCarriers = [] }) {
  const known = new Set();
  for (const row of storedCarriers ?? []) {
    const id = String(row?.shipstationCarrierId || row?.shipstation_carrier_id || '').trim();
    const code = String(row?.carrierCode || row?.carrier_code || '').trim();
    if (id) known.add(id);
    if (code) known.add(code);
  }
  return [...new Set(carrierCodes.map((code) => String(code || '').trim()).filter(Boolean))].filter(
    (code) => !known.has(code),
  );
}

export function catalogFailureMessage(failures) {
  const items = (failures ?? []).filter((item) => item?.message);
  if (items.length === 0) return 'Could not pull package types from ShipStation.';
  if (items.length === 1) {
    const only = items[0];
    const who = only.carrierName
      ? `${only.carrierName} package types`
      : only.scope === 'custom'
        ? 'custom package types'
        : 'package types';
    return `Could not pull ${who} from ShipStation: ${only.message}`;
  }
  const names = items
    .map((item) => item.carrierName || (item.scope === 'custom' ? 'custom packages' : 'a carrier'))
    .slice(0, 8);
  const rest = items.length - names.length;
  const list = rest > 0 ? `${names.join(', ')}, and ${rest} more` : names.join(', ');
  return `Could not pull package types from ShipStation for ${list}: ${items[0].message}`;
}

export function catalogPullMessage({ kind, items }) {
  const count = items?.length ?? 0;
  const noun = kind === 'carriers' ? 'carrier' : 'package';
  const label = count === 1 ? noun : `${noun}s`;
  const names = (items ?? []).map((item) => {
    const name = String(item?.name || item?.packageCode || item?.carrierCode || 'Unknown').trim();
    if (kind === 'packages' && item?.carrierName) return `${name} (${item.carrierName})`;
    return name;
  });
  const shown = names.slice(0, 8);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ');
  return `Pulled ${count} new ${label} from ShipStation: ${list}.`;
}

export async function recordNewPackages({ db, connectionId, packages }) {
  const { results } = await db
    .prepare(
      `SELECT source, ss_carrier_id, package_code
       FROM shipstation_seen_package
       WHERE connection_id = ?`,
    )
    .bind(connectionId)
    .all();
  const known = (results ?? []).map((row) =>
    packageSeenKey({
      source: row.source,
      carrierId: row.ss_carrier_id,
      packageCode: row.package_code,
    }),
  );
  const added = unseenPackages(known, packages);
  const chunkSize = d1InsertChunkSize(6);
  for (let index = 0; index < added.length; index += chunkSize) {
    const chunk = added.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, 0)').join(', ');
    const binds = [];
    for (const pkg of chunk) {
      binds.push(
        connectionId,
        pkg.source === 'custom' ? 'custom' : 'carrier',
        String(pkg.carrierId || pkg.carrierCode || '').trim(),
        String(pkg.packageCode).trim(),
        String(pkg.name || pkg.packageCode).trim(),
      );
    }
    await db
      .prepare(
        `INSERT INTO shipstation_seen_package
           (connection_id, source, ss_carrier_id, package_code, package_name, deleted)
         VALUES ${placeholders}`,
      )
      .bind(...binds)
      .run();
  }
  return added;
}

/**
 * V2 lists packages by carrier id (`GET /v2/carriers/{carrier_id}/packages`).
 * The queue often only knows the carrier code, so resolve those codes through the
 * stored carrier catalog. V1 lists by carrier code.
 */
export function packageListTargets({ apiVersion, carrierIds = [], carrierCodes = [], storedCarriers = [] }) {
  if (apiVersion === 'v1') {
    return carrierCodes.map((carrierCode) => ({ carrierId: null, carrierCode }));
  }
  const targets = new Map();
  const rows = storedCarriers ?? [];
  const idOf = (row) => String(row?.shipstationCarrierId || row?.shipstation_carrier_id || '').trim();
  const codeOf = (row) => String(row?.carrierCode || row?.carrier_code || '').trim();
  const add = (id, carrierCode) => {
    const carrierId = String(id || '').trim();
    if (!carrierId || targets.has(carrierId)) return;
    targets.set(carrierId, {
      carrierId,
      carrierCode: String(carrierCode || '').trim() || null,
    });
  };
  for (const id of carrierIds) {
    const row = rows.find((entry) => idOf(entry) === id);
    add(id, codeOf(row));
  }
  for (const code of carrierCodes) {
    const row = rows.find((entry) => codeOf(entry) === code || idOf(entry) === code);
    if (row) add(idOf(row), codeOf(row) || code);
  }
  return [...targets.values()];
}

export function createPackageCatalogCache() {
  return { custom: undefined, carriers: new Map() };
}

async function loadCustomPackages({ credentials, cache, listCustomPackageTypes, timeoutMs }) {
  if (cache.custom) return cache.custom;
  if (credentials.apiVersion === 'v1') {
    cache.custom = { ok: true, packages: [] };
    return cache.custom;
  }
  const listed = await listCustomPackageTypes({ credentials, timeoutMs });
  cache.custom = listed.ok
    ? { ok: true, packages: normalizePackageList(listed.data, { source: 'custom' }) }
    : { ok: false, message: listed.message || 'Could not list custom packages.', packages: [] };
  return cache.custom;
}

async function loadCarrierPackages({
  credentials,
  carrierId,
  carrierCode,
  cache,
  listCarrierPackageTypes,
  timeoutMs,
}) {
  const key =
    credentials.apiVersion === 'v1'
      ? `v1:${String(carrierCode || '').trim()}`
      : `v2:${String(carrierId || '').trim()}`;
  if (cache.carriers.has(key)) return cache.carriers.get(key);
  const listed = await listCarrierPackageTypes({ credentials, carrierId, carrierCode, timeoutMs });
  const entry = listed.ok
    ? {
        ok: true,
        packages: normalizePackageList(listed.data, {
          source: 'carrier',
          carrierId,
          carrierCode,
        }),
      }
    : {
        ok: false,
        message: listed.message || 'Could not list carrier packages.',
        packages: [],
      };
  cache.carriers.set(key, entry);
  return entry;
}

export async function loadAccountCustomPackages({ credentials, cache, timeoutMs }) {
  const { listCustomPackageTypes } = await import('./shipstation.js');
  const store = cache || createPackageCatalogCache();
  return loadCustomPackages({ credentials, cache: store, listCustomPackageTypes, timeoutMs });
}

/** One carrier's package types. Custom packages are loaded separately so parallel calls do not repeat them. */
export async function loadCarrierCatalog({ credentials, carrierId, carrierCode, cache, timeoutMs }) {
  const { listCarrierPackageTypes } = await import('./shipstation.js');
  const store = cache || createPackageCatalogCache();
  return loadCarrierPackages({
    credentials,
    carrierId,
    carrierCode,
    cache: store,
    listCarrierPackageTypes,
    timeoutMs,
  });
}

/** Custom packages plus one carrier's packages. Cache is per push batch. */
export async function loadPushCatalog({ credentials, carrierId, carrierCode, cache, timeoutMs }) {
  const { listCarrierPackageTypes, listCustomPackageTypes } = await import('./shipstation.js');
  const store = cache || createPackageCatalogCache();
  const custom = await loadCustomPackages({
    credentials,
    cache: store,
    listCustomPackageTypes,
    timeoutMs,
  });
  if (!custom.ok) {
    return { ok: false, message: custom.message, customPackages: [], carrierPackages: [] };
  }
  const carrier = await loadCarrierPackages({
    credentials,
    carrierId,
    carrierCode,
    cache: store,
    listCarrierPackageTypes,
    timeoutMs,
  });
  if (!carrier.ok) {
    return { ok: false, message: carrier.message, customPackages: custom.packages, carrierPackages: [] };
  }
  return { ok: true, customPackages: custom.packages, carrierPackages: carrier.packages };
}

/**
 * V2 shipment packages, or the single V1 order package.
 * `record` is a shipment, a label-less order, or a create envelope.
 */
export function pulledPackagesFromRecord(record, apiVersion) {
  if (!record || typeof record !== 'object') return [];
  if (apiVersion === 'v1') {
    const order =
      record.packageCode || record.weight || record.dimensions ? record : record.order || record;
    if (!order?.packageCode && !order?.weight && !order?.dimensions) return [];
    return [
      {
        packageCode: String(order.packageCode || 'package').trim() || 'package',
        packageName: null,
        packageId: null,
        externalPackageId: null,
        dimensions: normalizePackageDimensions(order.dimensions),
        weight: normalizePackageWeight(order.weight),
      },
    ];
  }
  const shipment = Array.isArray(record.shipments) ? record.shipments[0] : record;
  const packages = Array.isArray(shipment?.packages) ? shipment.packages : [];
  return packages.map((pkg) => ({
    packageCode: String(pkg?.package_code || pkg?.packageCode || 'package').trim() || 'package',
    packageName: String(pkg?.package_name || pkg?.packageName || pkg?.name || '').trim() || null,
    packageId: String(pkg?.package_id || pkg?.packageId || '').trim() || null,
    externalPackageId:
      String(pkg?.external_package_id || pkg?.externalPackageId || '').trim() || null,
    dimensions: normalizePackageDimensions(pkg?.dimensions),
    weight: normalizePackageWeight(pkg?.weight),
  }));
}

export const PACKAGE_CATALOG_TIMEOUT_MS = 8000;

export const PACKAGE_CATALOG_EMPTY_MESSAGE =
  'Package types have not been loaded from ShipStation yet.';

/** D1 rejects a statement with more than 100 bound parameters. */
export function d1InsertChunkSize(bindsPerRow) {
  const width = Math.max(1, Number(bindsPerRow) || 1);
  return Math.max(1, Math.floor(100 / width));
}

const PACKAGE_CATALOG_RETRY_MS = 15 * 60 * 1000;

function attemptAgeMs(lastAttempt, now) {
  if (!lastAttempt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(`${String(lastAttempt).trim().replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return now.getTime() - parsed;
}

function catalogStorageKey(pkg) {
  const source = pkg?.source === 'custom' ? 'custom' : 'carrier';
  const carrier = String(pkg?.ssCarrierId || pkg?.carrierId || pkg?.ss_carrier_id || '').trim();
  const code = String(pkg?.packageCode || pkg?.package_code || '').trim();
  return `${source}\0${carrier}\0${code}`;
}

function storedDimensions(pkg) {
  const dimensions = pkg?.dimensions;
  if (!dimensions) return { length: null, width: null, height: null, unit: null };
  return {
    length: dimensions.length ?? null,
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    unit: dimensions.unit || null,
  };
}

function sameStoredNumber(left, right) {
  if (left == null && right == null) return true;
  return Number(left) === Number(right);
}

export function catalogRowDiffers(row, pkg) {
  const dims = storedDimensions(pkg);
  const carrierCode = String(pkg.carrierCode || '').trim();
  const packageId = pkg.packageId || null;
  const description = pkg.description || null;
  return (
    String(row.package_name || '') !== String(pkg.name || pkg.packageCode || '') ||
    String(row.package_id || '') !== String(packageId || '') ||
    String(row.carrier_code || '') !== carrierCode ||
    String(row.description || '') !== String(description || '') ||
    !sameStoredNumber(row.length, dims.length) ||
    !sameStoredNumber(row.width, dims.width) ||
    !sameStoredNumber(row.height, dims.height) ||
    String(row.dimension_unit || '') !== String(dims.unit || '')
  );
}

/** Insert, update, or retire rows. `existing` must be only the scopes that were fetched. */
export function planPackageCatalogWrites({ existing, incoming }) {
  const incomingByKey = new Map();
  for (const pkg of incoming ?? []) {
    const code = String(pkg?.packageCode || '').trim();
    const carrier = String(pkg?.carrierId || pkg?.carrierCode || '').trim();
    if (!code) continue;
    if (pkg?.source !== 'custom' && !carrier) continue;
    incomingByKey.set(
      catalogStorageKey({
        source: pkg.source,
        carrierId: pkg.source === 'custom' ? '' : carrier,
        packageCode: code,
      }),
      pkg,
    );
  }
  const existingByKey = new Map();
  for (const row of existing ?? []) {
    if (row.deleted) continue;
    existingByKey.set(
      catalogStorageKey({
        source: row.source,
        ss_carrier_id: row.ss_carrier_id,
        packageCode: row.package_code,
      }),
      row,
    );
  }
  const insert = [];
  const update = [];
  for (const [key, pkg] of incomingByKey) {
    const row = existingByKey.get(key);
    if (!row) {
      insert.push(pkg);
      continue;
    }
    if (catalogRowDiffers(row, pkg)) update.push({ id: row.id, pkg });
  }
  const retire = [];
  for (const [key, row] of existingByKey) {
    if (!incomingByKey.has(key)) retire.push(row.id);
  }
  return { insert, update, retire };
}

/**
 * Which connections the scheduled job should refresh.
 * Nightly (12:00–12:09 AM Pacific) refreshes every connection not already pulled that date.
 * Outside that window, one connection that has never succeeded is filled, and a failed
 * attempt is tried again after 15 minutes. The platform schedule is an interval, not a clock.
 */
export function packageCatalogConnectionsDue({ rows, now = new Date() }) {
  const night = isActivityPruneWindow(now);
  const today = pacificDate(now);
  const due = [];
  for (const row of rows ?? []) {
    if (night) {
      if (row.pulled_on === today) continue;
      due.push(row);
      continue;
    }
    if (!row.pulled_on && attemptAgeMs(row.last_attempt_at, now) >= PACKAGE_CATALOG_RETRY_MS) {
      due.push(row);
      break;
    }
  }
  return { night, today, due, skipped: due.length === 0 };
}

function catalogOption(row) {
  const length = row.length == null ? null : Number(row.length);
  const width = row.width == null ? null : Number(row.width);
  const height = row.height == null ? null : Number(row.height);
  const dimensions =
    length != null && width != null && height != null
      ? { length, width, height, unit: row.dimension_unit || 'inch' }
      : null;
  return {
    source: row.source === 'custom' ? 'custom' : 'carrier',
    packageCode: row.package_code,
    packageId: row.package_id || null,
    name: row.package_name,
    description: row.description || null,
    carrierId: row.ss_carrier_id || null,
    carrierCode: row.carrier_code || null,
    dimensions,
  };
}

export function groupStoredPackages(rows) {
  const customPackages = [];
  const groups = new Map();
  for (const row of rows ?? []) {
    const option = catalogOption(row);
    if (option.source === 'custom') {
      customPackages.push(option);
      continue;
    }
    const key = `${option.carrierId || ''}\0${option.carrierCode || ''}`;
    const group = groups.get(key) ?? {
      carrierId: option.carrierId,
      carrierCode: option.carrierCode,
      packages: [],
    };
    group.packages.push(option);
    groups.set(key, group);
  }
  return { customPackages, carrierPackages: [...groups.values()] };
}

export async function storedPushCatalog({ db, connectionId, carrierId, carrierCode }) {
  const stored = await readStoredPackageCatalog({ db, connectionId });
  if (!stored.synced && stored.customPackages.length === 0 && stored.carrierPackages.length === 0) {
    return {
      ok: false,
      message: PACKAGE_CATALOG_EMPTY_MESSAGE,
      customPackages: [],
      carrierPackages: [],
    };
  }
  const id = String(carrierId || '').trim();
  const code = String(carrierCode || '').trim();
  const group = stored.carrierPackages.find(
    (entry) => (id && entry.carrierId === id) || (code && entry.carrierCode === code),
  );
  return {
    ok: true,
    customPackages: stored.customPackages,
    carrierPackages: group?.packages ?? [],
  };
}

export async function readStoredPackageCatalog({ db, connectionId }) {
  const sync = await db
    .prepare(`SELECT pulled_on, last_attempt_at FROM package_catalog_sync WHERE connection_id = ?`)
    .bind(connectionId)
    .first();
  const { results } = await db
    .prepare(
      `SELECT source, ss_carrier_id, carrier_code, package_code, package_id, package_name,
              description, length, width, height, dimension_unit
       FROM package_catalog
       WHERE connection_id = ? AND deleted = 0
       ORDER BY package_name COLLATE NOCASE, package_code`,
    )
    .bind(connectionId)
    .all();
  const grouped = groupStoredPackages(results ?? []);
  return {
    ...grouped,
    synced: Boolean(sync?.pulled_on),
    lastAttemptAt: sync?.last_attempt_at ?? null,
    errors: [],
  };
}

function catalogGroupCovers(groups, target) {
  const id = String(target?.carrierId || '').trim();
  const code = String(target?.carrierCode || '').trim();
  return (groups ?? []).some(
    (entry) => (id && entry.carrierId === id) || (code && entry.carrierCode === code),
  );
}

/** Carriers the queue asked for that are not in the stored catalog yet. */
export function missingCatalogTargets({
  apiVersion,
  carrierIds = [],
  carrierCodes = [],
  storedCarriers = [],
  storedGroups = [],
}) {
  return packageListTargets({ apiVersion, carrierIds, carrierCodes, storedCarriers }).filter(
    (target) => !catalogGroupCovers(storedGroups, target),
  );
}

async function existingCatalogRows({ db, connectionId, source, carrierId }) {
  if (source === 'custom') {
    const { results } = await db
      .prepare(
        `SELECT id, source, ss_carrier_id, carrier_code, package_code, package_id, package_name,
                description, length, width, height, dimension_unit, deleted
         FROM package_catalog
         WHERE connection_id = ? AND source = 'custom' AND deleted = 0`,
      )
      .bind(connectionId)
      .all();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT id, source, ss_carrier_id, carrier_code, package_code, package_id, package_name,
              description, length, width, height, dimension_unit, deleted
       FROM package_catalog
       WHERE connection_id = ? AND source = 'carrier' AND ss_carrier_id = ? AND deleted = 0`,
    )
    .bind(connectionId, carrierId)
    .all();
  return results ?? [];
}

function bindPackage(connectionId, pkg) {
  const source = pkg.source === 'custom' ? 'custom' : 'carrier';
  const carrier = source === 'custom' ? '' : String(pkg.carrierId || pkg.carrierCode || '').trim();
  const dims = storedDimensions(pkg);
  return [
    connectionId,
    source,
    carrier,
    source === 'custom' ? '' : String(pkg.carrierCode || '').trim(),
    String(pkg.packageCode).trim(),
    pkg.packageId || null,
    String(pkg.name || pkg.packageCode).trim(),
    pkg.description || null,
    dims.length,
    dims.width,
    dims.height,
    dims.unit,
  ];
}

async function applyCatalogPlan({ db, connectionId, plan }) {
  const chunkSize = d1InsertChunkSize(12);
  for (let index = 0; index < plan.insert.length; index += chunkSize) {
    const chunk = plan.insert.slice(index, index + chunkSize);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)').join(', ');
    const binds = chunk.flatMap((pkg) => bindPackage(connectionId, pkg));
    await db
      .prepare(
        `INSERT INTO package_catalog
           (connection_id, source, ss_carrier_id, carrier_code, package_code, package_id,
            package_name, description, length, width, height, dimension_unit, deleted)
         VALUES ${placeholders}`,
      )
      .bind(...binds)
      .run();
  }
  for (const change of plan.update) {
    const values = bindPackage(connectionId, change.pkg).slice(1);
    await db
      .prepare(
        `UPDATE package_catalog
         SET source = ?, ss_carrier_id = ?, carrier_code = ?, package_code = ?, package_id = ?,
             package_name = ?, description = ?, length = ?, width = ?, height = ?,
             dimension_unit = ?, deleted = 0, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(...values, change.id)
      .run();
  }
  for (const id of plan.retire) {
    await db
      .prepare(
        `UPDATE package_catalog
         SET deleted = 1, updated_at = datetime('now')
         WHERE id = ? AND deleted = 0`,
      )
      .bind(id)
      .run();
  }
}

async function writeCatalogScope({ db, connectionId, source, carrierId, packages }) {
  const existing = await existingCatalogRows({ db, connectionId, source, carrierId });
  const plan = planPackageCatalogWrites({ existing, incoming: packages });
  await applyCatalogPlan({ db, connectionId, plan });
  return plan.insert;
}

export async function markPackageCatalogAttempt({ db, connectionId, pulledOn = null }) {
  await db
    .prepare(
      `INSERT INTO package_catalog_sync (connection_id, pulled_on, last_attempt_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(connection_id) DO UPDATE SET
         pulled_on = COALESCE(excluded.pulled_on, package_catalog_sync.pulled_on),
         last_attempt_at = datetime('now')`,
    )
    .bind(connectionId, pulledOn)
    .run();
}

/** Pull custom packages and stored carriers' packages. Writes only rows that changed. */
export async function refreshConnectionPackageCatalog({
  db,
  connectionId,
  credentials,
  timeoutMs = PACKAGE_CATALOG_TIMEOUT_MS,
  carrierIds = null,
  carrierCodes = null,
  includeCustom = true,
  onlyRequested = false,
}) {
  const { results: storedCarriers } = await db
    .prepare(
      `SELECT shipstation_carrier_id, carrier_code, name
       FROM shipstation_carrier
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .all();
  const allTargets = packageListTargets({
    apiVersion: credentials.apiVersion,
    carrierIds: (storedCarriers ?? []).map((row) => row.shipstation_carrier_id).filter(Boolean),
    carrierCodes: (storedCarriers ?? []).map((row) => row.carrier_code).filter(Boolean),
    storedCarriers: storedCarriers ?? [],
  });
  const targets = onlyRequested
    ? packageListTargets({
        apiVersion: credentials.apiVersion,
        carrierIds: carrierIds ?? [],
        carrierCodes: carrierCodes ?? [],
        storedCarriers: storedCarriers ?? [],
      })
    : allTargets;
  const cache = createPackageCatalogCache();
  const custom = includeCustom
    ? await loadAccountCustomPackages({ credentials, cache, timeoutMs })
    : { ok: true, packages: null };
  const loadedCarriers = await Promise.all(
    targets.map(async (target) => ({
      target,
      loaded: await loadCarrierCatalog({ credentials, ...target, cache, timeoutMs }),
    })),
  );
  const failures = [];
  const added = [];
  if (includeCustom) {
    if (!custom.ok) {
      failures.push({ scope: 'custom', message: custom.message || 'Could not list custom packages.' });
    } else {
      added.push(
        ...(await writeCatalogScope({
          db,
          connectionId,
          source: 'custom',
          packages: custom.packages ?? [],
        })),
      );
    }
  }
  for (const { target, loaded } of loadedCarriers) {
    const carrierId = String(target.carrierId || target.carrierCode || '').trim();
    if (!loaded.ok) {
      const row = (storedCarriers ?? []).find(
        (carrier) =>
          carrier.shipstation_carrier_id === target.carrierId ||
          carrier.carrier_code === target.carrierCode,
      );
      failures.push({
        scope: 'carrier',
        carrierName: row?.name || target.carrierCode || target.carrierId || null,
        message: loaded.message || 'Could not list carrier packages.',
      });
      continue;
    }
    const packages = (loaded.packages ?? []).map((pkg) => ({
      ...pkg,
      carrierId: pkg.carrierId || target.carrierId || carrierId,
      carrierCode: pkg.carrierCode || target.carrierCode || null,
    }));
    added.push(
      ...(await writeCatalogScope({
        db,
        connectionId,
        source: 'carrier',
        carrierId,
        packages,
      })),
    );
  }
  return { ok: failures.length === 0, failures, added };
}

export async function syncConnectionPackageCatalog({
  db,
  connectionId,
  organizationId,
  credentials,
  actor = 'schedule',
  pulledOn,
  markSynced = true,
  carrierIds = null,
  carrierCodes = null,
  includeCustom = true,
  onlyRequested = false,
}) {
  const result = await refreshConnectionPackageCatalog({
    db,
    connectionId,
    credentials,
    carrierIds,
    carrierCodes,
    includeCustom,
    onlyRequested,
  });
  if (markSynced) {
    await markPackageCatalogAttempt({
      db,
      connectionId,
      pulledOn: result.ok ? pulledOn : null,
    });
  }
  if (organizationId && result.added.length > 0) {
    const recorded = await recordNewPackages({
      db,
      connectionId,
      packages: result.added,
    });
    if (recorded.length > 0) {
      await appendActivity({
        db,
        organizationId,
        actor,
        action: 'catalog_pull',
        status: 'success',
        message: catalogPullMessage({ kind: 'packages', items: recorded }),
        detail: {
          packages: recorded.slice(0, 40).map((pkg) => ({
            name: pkg.name,
            packageCode: pkg.packageCode,
            source: pkg.source,
            carrierCode: pkg.carrierCode || null,
          })),
        },
      });
    }
  }
  if (organizationId && !result.ok) {
    await appendActivity({
      db,
      organizationId,
      actor,
      action: 'catalog_pull',
      status: 'error',
      message: catalogFailureMessage(result.failures),
      detail: {
        errors: result.failures.slice(0, 20).map((entry) => ({
          scope: entry.scope || null,
          carrierName: entry.carrierName || null,
          message: entry.message,
        })),
      },
    });
  }
  return result;
}

/**
 * The dropdown reads stored rows. When a requested carrier (or custom packages) is missing,
 * pull those from ShipStation and return the catalog, including any packages that were saved.
 */
export async function ensurePackageCatalog({
  db,
  connectionId,
  organizationId,
  credentials,
  carrierIds = [],
  carrierCodes = [],
  actor = 'user',
  force = false,
}) {
  const current = await readStoredPackageCatalog({ db, connectionId });
  const { results: storedCarriers } = await db
    .prepare(
      `SELECT shipstation_carrier_id, carrier_code, name
       FROM shipstation_carrier
       WHERE connection_id = ? AND deleted = 0`,
    )
    .bind(connectionId)
    .all();
  const requested = packageListTargets({
    apiVersion: credentials.apiVersion,
    carrierIds,
    carrierCodes,
    storedCarriers: storedCarriers ?? [],
  });
  const missing = force
    ? requested
    : requested.filter((target) => !catalogGroupCovers(current.carrierPackages, target));
  const customStale = attemptAgeMs(current.lastAttemptAt, new Date()) >= PACKAGE_CATALOG_RETRY_MS;
  const needCustom =
    credentials.apiVersion !== 'v1' &&
    current.customPackages.length === 0 &&
    (force || customStale);
  if (missing.length === 0 && !needCustom) return current;
  const result = await syncConnectionPackageCatalog({
    db,
    connectionId,
    organizationId,
    credentials,
    actor,
    markSynced: false,
    includeCustom: needCustom,
    onlyRequested: true,
    carrierIds: missing.map((target) => target.carrierId).filter(Boolean),
    carrierCodes: missing.map((target) => target.carrierCode).filter(Boolean),
  });
  await markPackageCatalogAttempt({ db, connectionId, pulledOn: null });
  const stored = await readStoredPackageCatalog({ db, connectionId });
  if (result.ok) return stored;
  return {
    ...stored,
    errors: [{ message: catalogFailureMessage(result.failures) }],
  };
}
