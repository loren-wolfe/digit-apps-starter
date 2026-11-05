/**
 * Per-pack-container ShipStation package choice. Stored in D1 only — never written
 * to the Sutton sales order or shipment.
 */

export function missingPackageTypeReason(selection) {
  const name = String(selection?.packageName || selection?.packageCode || '').trim();
  const label = name || 'The selected package type';
  return `${label} is no longer available in ShipStation. Pick another package type or use Sutton dimensions, then try again.`;
}

export function shipmentPackageLocked(mapRow) {
  if (!mapRow) return false;
  if (mapRow.source === 'shipstation') return true;
  if (mapRow.ssShipmentId || mapRow.ss_shipment_id) return true;
  const status = mapRow.pushStatus || mapRow.push_status;
  return ['pushed', 'label_ready', 'shipped'].includes(status);
}

/**
 * A carrier package belongs to the carrier it was picked for. Custom packages stay.
 * Only compares once the current Sutton carrier resolves to a ShipStation carrier.
 */
export function isStaleCarrierSelection(selection, carrier) {
  if (!selection || selection.source !== 'carrier') return false;
  if (!carrier || carrier.status !== 'ok') return false;
  const savedId = String(selection.ssCarrierId || '').trim();
  const savedCode = String(selection.ssCarrierCode || '').trim();
  const nextId = String(carrier.carrierId || '').trim();
  const nextCode = String(carrier.carrierCode || '').trim();
  if (savedId && nextId) return savedId !== nextId;
  if (savedCode && nextCode) return savedCode !== nextCode;
  return false;
}

function findCatalogPackage(list, packageCode) {
  const code = String(packageCode || '').trim();
  return (list ?? []).find((pkg) => pkg.packageCode === code) ?? null;
}

/**
 * Drop carrier packages for a different carrier. Flag a saved code the catalog
 * no longer lists. `overridesByContainerId` is what push should send.
 */
export function resolvePushPackageSelections({ selections, carrier, customPackages, carrierPackages }) {
  const stale = [];
  const overridesByContainerId = {};
  let missing = null;

  for (const selection of selections ?? []) {
    if (!selection?.digitContainerId || !selection.packageCode) continue;
    if (isStaleCarrierSelection(selection, carrier)) {
      stale.push(selection);
      continue;
    }
    const match =
      selection.source === 'carrier'
        ? findCatalogPackage(carrierPackages, selection.packageCode)
        : selection.source === 'custom'
          ? findCatalogPackage(customPackages, selection.packageCode)
          : findCatalogPackage(customPackages, selection.packageCode) ||
            findCatalogPackage(carrierPackages, selection.packageCode);
    if (!match) {
      missing = selection;
      break;
    }
    overridesByContainerId[selection.digitContainerId] = {
      packageCode: match.packageCode,
      packageId: match.packageId ?? null,
      dimensions: match.dimensions ?? null,
    };
  }

  return { stale, missing, overridesByContainerId };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameNumber(left, right) {
  const a = finiteNumber(left);
  const b = finiteNumber(right);
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.0001;
}

function dimensionSnapshot(dimensions) {
  if (!dimensions) return null;
  const length = finiteNumber(dimensions.length);
  const width = finiteNumber(dimensions.width);
  const height = finiteNumber(dimensions.height);
  if (length == null || width == null || height == null) return null;
  return {
    length,
    width,
    height,
    unit: dimensions.unit === 'centimeter' ? 'centimeter' : 'inch',
  };
}

export function selectionDimensions(selection) {
  if (!selection) return null;
  return dimensionSnapshot({
    length: selection.length,
    width: selection.width,
    height: selection.height,
    unit: selection.dimensionUnit,
  });
}

/**
 * Match ShipStation packages back onto Sutton pack containers.
 * V2 uses external_package_id. A single unidentified package updates the single
 * container (V1). Several packages without ids are left unchanged.
 */
export function matchPulledPackages({ containerIds, packages }) {
  const ids = [...new Set((containerIds ?? []).map((id) => String(id || '').trim()).filter(Boolean))];
  const list = Array.isArray(packages) ? packages : [];
  const matches = [];
  const matchedIds = new Set();

  for (const pkg of list) {
    const external = String(pkg?.externalPackageId || '').trim();
    if (!external || !ids.includes(external) || matchedIds.has(external)) continue;
    matches.push({ digitContainerId: external, pkg });
    matchedIds.add(external);
  }

  if (matches.length === 0 && ids.length === 1 && list.length === 1) {
    matches.push({ digitContainerId: ids[0], pkg: list[0] });
  }

  return matches;
}

export function observedPackageSnapshot(existing, pulled) {
  const packageCode = String(pulled?.packageCode || '').trim();
  const sameCode = existing && existing.packageCode === packageCode;
  const packageName =
    String(pulled?.packageName || '').trim() ||
    (sameCode ? String(existing?.packageName || '').trim() : '') ||
    packageCode;
  const dimensions = dimensionSnapshot(pulled?.dimensions);
  const weightValue = finiteNumber(pulled?.weight?.value);
  const weightUnit = weightValue == null ? null : String(pulled?.weight?.unit || '').trim() || null;
  return {
    packageCode,
    packageName,
    packageId: pulled?.packageId || null,
    dimensions,
    weightValue,
    weightUnit,
  };
}

export function packageObservationChanged(existing, pulled) {
  const next = observedPackageSnapshot(existing, pulled);
  if (!next.packageCode) return false;
  if (!existing) return true;
  const currentDimensions = selectionDimensions(existing);
  return (
    existing.packageCode !== next.packageCode ||
    String(existing.packageName || '') !== next.packageName ||
    String(existing.packageId || '') !== String(next.packageId || '') ||
    !sameNumber(currentDimensions?.length, next.dimensions?.length) ||
    !sameNumber(currentDimensions?.width, next.dimensions?.width) ||
    !sameNumber(currentDimensions?.height, next.dimensions?.height) ||
    (currentDimensions?.unit || null) !== (next.dimensions?.unit || null) ||
    !sameNumber(existing.weightValue, next.weightValue) ||
    String(existing.weightUnit || '') !== String(next.weightUnit || '') ||
    !existing.observedFromShipstation
  );
}

export function publicPackageSelection(row) {
  if (!row) return null;
  const numberOrNull = (value) => {
    const number = finiteNumber(value);
    return number == null ? null : number;
  };
  return {
    digitShipmentId: row.digit_shipment_id,
    digitContainerId: row.digit_container_id,
    source: row.source,
    packageCode: row.package_code,
    packageId: row.package_id ?? null,
    packageName: row.package_name ?? null,
    ssCarrierId: row.ss_carrier_id ?? null,
    ssCarrierCode: row.ss_carrier_code ?? null,
    length: numberOrNull(row.length),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    dimensionUnit: row.dimension_unit ?? null,
    weightValue: numberOrNull(row.weight_value),
    weightUnit: row.weight_unit ?? null,
    observedFromShipstation: Number(row.observed_from_shipstation) === 1,
  };
}

export async function selectionsForShipments({ db, connectionId, shipmentIds }) {
  if (!shipmentIds?.length) return [];
  const placeholders = shipmentIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT digit_shipment_id, digit_container_id, source, package_code, package_id, package_name,
              ss_carrier_id, ss_carrier_code, length, width, height, dimension_unit,
              weight_value, weight_unit, observed_from_shipstation
       FROM package_selection
       WHERE connection_id = ? AND deleted = 0 AND digit_shipment_id IN (${placeholders})`,
    )
    .bind(connectionId, ...shipmentIds)
    .all();
  return (results ?? []).map(publicPackageSelection);
}

export async function selectionsForShipment({ db, connectionId, digitShipmentId }) {
  return selectionsForShipments({ db, connectionId, shipmentIds: [digitShipmentId] });
}

export async function selectionForContainer({ db, connectionId, digitContainerId }) {
  const row = await db
    .prepare(
      `SELECT digit_shipment_id, digit_container_id, source, package_code, package_id, package_name,
              ss_carrier_id, ss_carrier_code, length, width, height, dimension_unit,
              weight_value, weight_unit, observed_from_shipstation
       FROM package_selection
       WHERE connection_id = ? AND digit_container_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(connectionId, digitContainerId)
    .first();
  return publicPackageSelection(row);
}

async function liveSelectionId({ db, connectionId, digitContainerId }) {
  const row = await db
    .prepare(
      `SELECT id FROM package_selection
       WHERE connection_id = ? AND digit_container_id = ? AND deleted = 0
       LIMIT 1`,
    )
    .bind(connectionId, digitContainerId)
    .first();
  return row?.id ?? null;
}

export async function clearPackageSelection({ db, connectionId, digitContainerId }) {
  await db
    .prepare(
      `UPDATE package_selection
       SET deleted = 1, updated_at = datetime('now')
       WHERE connection_id = ? AND digit_container_id = ? AND deleted = 0`,
    )
    .bind(connectionId, digitContainerId)
    .run();
}

export async function upsertPackageSelection({
  db,
  connectionId,
  organizationId,
  digitShipmentId,
  digitContainerId,
  source,
  packageCode,
  packageId = null,
  packageName = null,
  ssCarrierId = null,
  ssCarrierCode = null,
  length = null,
  width = null,
  height = null,
  dimensionUnit = null,
  weightValue = null,
  weightUnit = null,
  observedFromShipstation = false,
}) {
  const existingId = await liveSelectionId({ db, connectionId, digitContainerId });
  const observed = observedFromShipstation ? 1 : 0;
  if (existingId) {
    await db
      .prepare(
        `UPDATE package_selection
         SET digit_shipment_id = ?, source = ?, package_code = ?, package_id = ?, package_name = ?,
             ss_carrier_id = ?, ss_carrier_code = ?, length = ?, width = ?, height = ?,
             dimension_unit = ?, weight_value = ?, weight_unit = ?,
             observed_from_shipstation = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(
        digitShipmentId,
        source,
        packageCode,
        packageId,
        packageName,
        ssCarrierId,
        ssCarrierCode,
        length,
        width,
        height,
        dimensionUnit,
        weightValue,
        weightUnit,
        observed,
        existingId,
      )
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO package_selection
         (connection_id, organization_id, digit_shipment_id, digit_container_id, source,
          package_code, package_id, package_name, ss_carrier_id, ss_carrier_code,
          length, width, height, dimension_unit, weight_value, weight_unit,
          observed_from_shipstation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      connectionId,
      organizationId,
      digitShipmentId,
      digitContainerId,
      source,
      packageCode,
      packageId,
      packageName,
      ssCarrierId,
      ssCarrierCode,
      length,
      width,
      height,
      dimensionUnit,
      weightValue,
      weightUnit,
      observed,
    )
    .run();
}

export async function saveObservedPackage({
  db,
  connectionId,
  organizationId,
  digitShipmentId,
  digitContainerId,
  existing,
  pulled,
}) {
  const next = observedPackageSnapshot(existing, pulled);
  if (!next.packageCode) return false;
  if (!packageObservationChanged(existing, pulled)) return false;
  await upsertPackageSelection({
    db,
    connectionId,
    organizationId,
    digitShipmentId,
    digitContainerId,
    source: 'shipstation',
    packageCode: next.packageCode,
    packageId: next.packageId,
    packageName: next.packageName,
    ssCarrierId: existing?.ssCarrierId ?? null,
    ssCarrierCode: existing?.ssCarrierCode ?? null,
    length: next.dimensions?.length ?? null,
    width: next.dimensions?.width ?? null,
    height: next.dimensions?.height ?? null,
    dimensionUnit: next.dimensions?.unit ?? null,
    weightValue: next.weightValue,
    weightUnit: next.weightUnit,
    observedFromShipstation: true,
  });
  return true;
}
