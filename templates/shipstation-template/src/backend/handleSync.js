import { AppErrorCode, parseJsonResponse, requiredString } from '@heysutton/sdk';
import { err, ok, requireEnv } from '@heysutton/sdk-server';

import { appendActivity, listActivity } from './activity.js';
import { MANUAL_PUSH_RETRY_MEANING } from './eligibility.js';
import { ensurePackageCatalog } from './packageCatalog.js';
import {
  clearPackageSelection,
  selectionsForShipments,
  shipmentPackageLocked,
  upsertPackageSelection,
} from './packageSelection.js';
import {
  completeShipmentWriteback,
  credentialsForApi,
  liveConnection,
  liveCredentials,
  mapsForShipments,
  mapsMatchingQuery,
  pendingShipmentWritebacks,
  pollPendingLabels,
  pushShipment,
  downloadPackingSlip,
  downloadShipmentLabel,
  recordSuttonApiUpdate,
} from './sync.js';

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

function pushResultRow(shipmentId, result) {
  if (result.ok) {
    return {
      shipmentId,
      orderId: result.data?.orderId ?? null,
      ok: true,
      skipped: Boolean(result.data?.skipped),
      ssShipmentId: result.data?.ssShipmentId ?? null,
      ssLabelId: result.data?.ssLabelId ?? null,
      message: result.data?.message ?? result.data?.reason ?? null,
      meaning: result.data?.meaning ?? result.data?.reason ?? null,
    };
  }
  const message = result.message || 'Push failed.';
  return {
    shipmentId,
    orderId: null,
    ok: false,
    skipped: false,
    ssShipmentId: null,
    ssLabelId: null,
    message,
    meaning: `${message} ${MANUAL_PUSH_RETRY_MEANING}`,
  };
}

export async function handleSync({ request, env, path, method }) {
  const packageRoute = path === '/package-types' || path === '/package-selections';
  if (!path.startsWith('/sync') && !packageRoute) return null;
  const db = requireEnv({ env, key: 'SHIPSTATION_DB' });
  const url = new URL(request.url);

  if (method === 'GET' && path === '/sync/shipments') {
    const org = requireOrganizationId(url);
    if (org.error) return org.error;
    const row = await liveConnection({ db, organizationId: org.organizationId });
    if (!row) {
      return ok({ data: { maps: [] } });
    }
    const ids = (url.searchParams.get('shipmentIds') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 250);
    const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
    const [byIds, byQuery] = await Promise.all([
      mapsForShipments({ db, connectionId: row.id, shipmentIds: ids }),
      query ? mapsMatchingQuery({ db, connectionId: row.id, query }) : Promise.resolve([]),
    ]);
    const mapsByShipment = new Map();
    for (const mapRow of byQuery) {
      if (mapRow?.digitShipmentId) mapsByShipment.set(mapRow.digitShipmentId, mapRow);
    }
    for (const mapRow of byIds) {
      if (mapRow?.digitShipmentId) mapsByShipment.set(mapRow.digitShipmentId, mapRow);
    }
    const maps = [...mapsByShipment.values()];
    const packageSelections = await selectionsForShipments({
      db,
      connectionId: row.id,
      shipmentIds: ids,
    });
    return ok({ data: { maps, packageSelections } });
  }

  if (method === 'GET' && path === '/sync/activity') {
    const org = requireOrganizationId(url);
    if (org.error) return org.error;
    const events = await listActivity({ db, organizationId: org.organizationId });
    return ok({ data: { events } });
  }

  if (method === 'POST' && path === '/sync/push') {
    const parsed = await parseJsonResponse({ value: request.json() });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const organizationIdResult = requiredString({ obj: parsed.value, key: 'organizationId' });
    if (!organizationIdResult.ok) {
      return err({
        code: organizationIdResult.error.code,
        message: organizationIdResult.error.message,
        status: 400,
      });
    }
    const organizationId = organizationIdResult.value;
    const shipmentIds = Array.isArray(parsed.value.shipmentIds)
      ? parsed.value.shipmentIds.map(String).filter(Boolean).slice(0, 25)
      : [];
    if (shipmentIds.length === 0) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'shipmentIds must be a non-empty array.',
        status: 400,
      });
    }
    const results = [];
    for (const shipmentId of shipmentIds) {
      const result = await pushShipment({
        env,
        db,
        organizationId,
        shipmentId,
        actor: 'user',
        recordActivity: true,
      });
      results.push(pushResultRow(shipmentId, result));
    }
    const summary = {
      pushed: results.filter((row) => row.ok && !row.skipped).length,
      skipped: results.filter((row) => row.ok && row.skipped).length,
      failed: results.filter((row) => !row.ok).length,
    };
    return ok({ data: { results, summary } });
  }

  if (method === 'POST' && path === '/sync/label') {
    const parsed = await parseJsonResponse({ value: request.json() });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const organizationIdResult = requiredString({ obj: parsed.value, key: 'organizationId' });
    if (!organizationIdResult.ok) {
      return err({
        code: organizationIdResult.error.code,
        message: organizationIdResult.error.message,
        status: 400,
      });
    }
    const shipmentIdResult = requiredString({ obj: parsed.value, key: 'shipmentId' });
    if (!shipmentIdResult.ok) {
      return err({
        code: shipmentIdResult.error.code,
        message: shipmentIdResult.error.message,
        status: 400,
      });
    }
    const organizationId = organizationIdResult.value;
    const shipmentId = shipmentIdResult.value;
    const result = await downloadShipmentLabel({ env, db, organizationId, shipmentId });
    if (!result.ok) {
      await appendActivity({
        db,
        organizationId,
        actor: 'user',
        action: 'label_download',
        status: 'error',
        message: result.message || 'Label download failed.',
        digitOrderId: null,
        ssShipmentId: null,
        detail: { code: result.code ?? null },
      });
      return err({
        code: result.code || AppErrorCode.UPSTREAM_ERROR,
        message: result.message || 'Label download failed.',
        status: result.status || 502,
      });
    }
    await appendActivity({
      db,
      organizationId,
      actor: 'user',
      action: 'label_download',
      status: 'success',
      message: 'Downloaded a shipping label from the queue.',
    });
    return ok({ data: result.data });
  }

  if (method === 'POST' && path === '/sync/packing-slip') {
    const parsed = await parseJsonResponse({ value: request.json() });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const organizationIdResult = requiredString({ obj: parsed.value, key: 'organizationId' });
    if (!organizationIdResult.ok) {
      return err({
        code: organizationIdResult.error.code,
        message: organizationIdResult.error.message,
        status: 400,
      });
    }
    const orderIdResult = requiredString({ obj: parsed.value, key: 'orderId' });
    if (!orderIdResult.ok) {
      return err({
        code: orderIdResult.error.code,
        message: orderIdResult.error.message,
        status: 400,
      });
    }
    const organizationId = organizationIdResult.value;
    const result = await downloadPackingSlip({
      env,
      db,
      organizationId,
      orderId: orderIdResult.value,
    });
    if (!result.ok) {
      await appendActivity({
        db,
        organizationId,
        actor: 'user',
        action: 'packing_slip_download',
        status: 'error',
        message: result.message || 'Packing slip download failed.',
        digitOrderId: orderIdResult.value,
        detail: { code: result.code ?? null },
      });
      return err({
        code: result.code || AppErrorCode.UPSTREAM_ERROR,
        message: result.message || 'Packing slip download failed.',
        status: result.status || 502,
      });
    }
    await appendActivity({
      db,
      organizationId,
      actor: 'user',
      action: 'packing_slip_download',
      status: 'success',
      message: 'Downloaded a Sutton packing slip from the queue.',
      digitOrderId: orderIdResult.value,
    });
    return ok({ data: result.data });
  }

  if (method === 'POST' && path === '/sync/poll') {
    let organizationId = null;
    const parsed = await parseJsonResponse({ value: request.json() });
    if (parsed.ok) {
      const value = String(parsed.value?.organizationId || '').trim();
      if (value) organizationId = value;
    }
    const labels = await pollPendingLabels({
      env,
      db,
      organizationId,
      actor: organizationId ? 'user' : 'schedule',
    });
    const pendingWritebacks = organizationId
      ? await pendingShipmentWritebacks({ env, db, organizationId })
      : [];
    if (organizationId) {
      const pulled = Number(labels.labelsPulled || 0);
      const candidates = Number(labels.labelCandidates || 0);
      await appendActivity({
        db,
        organizationId,
        actor: 'user',
        action: 'poll',
        status: 'success',
        message:
          pulled > 0
            ? `Pull from ShipStation pulled ${pulled} label(s).`
            : `Pull from ShipStation checked ${candidates} pushed shipment(s) and found no new ShipStation labels. Buy the label in ShipStation, then try again.`,
      });
    }
    return ok({ data: { ...labels, pendingWritebacks } });
  }

  if (method === 'POST' && path === '/sync/writeback-complete') {
    const parsed = await parseJsonResponse({ value: request.json() });
    if (!parsed.ok) return parsed.response;
    const organizationId = String(parsed.value?.organizationId || '').trim();
    const digitShipmentId = String(parsed.value?.digitShipmentId || '').trim();
    if (!organizationId || !digitShipmentId) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'organizationId and digitShipmentId are required.',
        status: 400,
      });
    }
    if (parsed.value?.recordOnly) {
      await recordSuttonApiUpdate({
        db,
        organizationId,
        kind: parsed.value.kind === 'order' ? 'order' : 'shipment',
        label: parsed.value.label || null,
        digitOrderId: parsed.value.digitOrderId || null,
        ok: false,
        message: parsed.value.message || 'Sutton did not accept the update.',
      });
      return ok({ data: { recorded: true } });
    }
    const result = await completeShipmentWriteback({
      env,
      db,
      organizationId,
      digitShipmentId,
      shipmentLabel: parsed.value?.shipmentLabel || null,
      orderLabel: parsed.value?.orderLabel || null,
    });
    if (!result.ok) return err(result);
    return ok({ data: result.data });
  }

  if (method === 'GET' && path === '/package-types') {
    const org = requireOrganizationId(url);
    if (org.error) return org.error;
    const secret = await liveCredentials({ db, env, organizationId: org.organizationId });
    const credentials = credentialsForApi(secret);
    if (!secret) {
      return ok({
        data: { apiVersion: null, customPackages: [], carrierPackages: [], errors: [] },
      });
    }
    if (!credentials) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: secret.mismatch || 'Connect a ShipStation account first.',
        status: 400,
      });
    }
    const carrierIds = String(url.searchParams.get('carrierIds') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const carrierCodes = String(url.searchParams.get('carrierCodes') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const stored = await ensurePackageCatalog({
      db,
      connectionId: secret.connectionId,
      organizationId: org.organizationId,
      credentials,
      carrierIds,
      carrierCodes,
      actor: 'user',
      force: url.searchParams.get('refresh') === '1',
    });
    return ok({
      data: {
        apiVersion: credentials.apiVersion,
        customPackages: stored.customPackages,
        carrierPackages: stored.carrierPackages,
        errors: stored.errors,
      },
    });
  }

  if (method === 'PUT' && path === '/package-selections') {
    const parsed = await parseJsonResponse({ value: request.json() });
    if (!parsed.ok) {
      return err({ code: parsed.error.code, message: parsed.error.message, status: 400 });
    }
    const organizationIdResult = requiredString({ obj: parsed.value, key: 'organizationId' });
    const shipmentIdResult = requiredString({ obj: parsed.value, key: 'digitShipmentId' });
    const containerIdResult = requiredString({ obj: parsed.value, key: 'digitContainerId' });
    if (!organizationIdResult.ok || !shipmentIdResult.ok || !containerIdResult.ok) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'organizationId, digitShipmentId, and digitContainerId are required.',
        status: 400,
      });
    }
    const organizationId = organizationIdResult.value;
    const digitShipmentId = shipmentIdResult.value;
    const digitContainerId = containerIdResult.value;
    const secret = await liveCredentials({ db, env, organizationId });
    if (!secret?.connectionId) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: secret?.mismatch || 'Connect a ShipStation account first.',
        status: 400,
      });
    }
    const mapRow = await db
      .prepare(
        `SELECT source, ss_shipment_id, push_status
         FROM shipstation_order_map
         WHERE connection_id = ? AND digit_shipment_id = ? AND deleted = 0
         LIMIT 1`,
      )
      .bind(secret.connectionId, digitShipmentId)
      .first();
    if (shipmentPackageLocked(mapRow)) {
      const message =
        'This shipment is already in ShipStation. Change the package there, then pull from ShipStation to refresh the queue.';
      await appendActivity({
        db,
        organizationId,
        actor: 'user',
        action: 'package_selection',
        status: 'error',
        message,
        digitOrderId: null,
        ssShipmentId: mapRow?.ss_shipment_id ?? null,
      });
      return err({ code: AppErrorCode.VALIDATION_ERROR, message, status: 400 });
    }
    if (parsed.value.clear) {
      await clearPackageSelection({
        db,
        connectionId: secret.connectionId,
        digitContainerId,
      });
      await appendActivity({
        db,
        organizationId,
        actor: 'user',
        action: 'package_selection',
        status: 'success',
        message: 'Cleared the ShipStation package type. Push will use Sutton dimensions.',
      });
      return ok({ data: { cleared: true, digitShipmentId, digitContainerId } });
    }
    const source = String(parsed.value.source || '').trim();
    const packageCode = String(parsed.value.packageCode || '').trim();
    const packageName = String(parsed.value.packageName || packageCode).trim();
    if ((source !== 'custom' && source !== 'carrier') || !packageCode || packageCode.length > 50) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'Choose a custom or carrier package type.',
        status: 400,
      });
    }
    const ssCarrierId = String(parsed.value.ssCarrierId || '').trim() || null;
    const ssCarrierCode = String(parsed.value.ssCarrierCode || '').trim() || null;
    if (source === 'carrier' && !ssCarrierId && !ssCarrierCode) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'Carrier packages need the mapped ShipStation carrier.',
        status: 400,
      });
    }
    const length = positiveDimension(parsed.value.length);
    const width = positiveDimension(parsed.value.width);
    const height = positiveDimension(parsed.value.height);
    const hasDimensions = length != null && width != null && height != null;
    const dimensionUnit =
      parsed.value.dimensionUnit === 'centimeter' ? 'centimeter' : hasDimensions ? 'inch' : null;
    await upsertPackageSelection({
      db,
      connectionId: secret.connectionId,
      organizationId,
      digitShipmentId,
      digitContainerId,
      source,
      packageCode,
      packageId: String(parsed.value.packageId || '').trim() || null,
      packageName,
      ssCarrierId: source === 'carrier' ? ssCarrierId : null,
      ssCarrierCode: source === 'carrier' ? ssCarrierCode : null,
      length: hasDimensions ? length : null,
      width: hasDimensions ? width : null,
      height: hasDimensions ? height : null,
      dimensionUnit: hasDimensions ? dimensionUnit : null,
    });
    await appendActivity({
      db,
      organizationId,
      actor: 'user',
      action: 'package_selection',
      status: 'success',
      message: `Selected ${packageName} for a package on this shipment. Push will send that ShipStation package type.`,
    });
    return ok({
      data: { cleared: false, digitShipmentId, digitContainerId, packageCode, packageName },
    });
  }

  return err({ code: AppErrorCode.NOT_FOUND, message: 'Not found.', status: 404 });
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
