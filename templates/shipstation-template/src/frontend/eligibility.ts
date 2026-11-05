/**
 * Keep in sync with src/backend/eligibility.js — the Worker cannot import this file.
 * Reverse-map logic mirrors src/backend/carrierMatch.js resolveSsServiceFromDigitOption.
 */

export type OrgSettingsForEligibility = {
  defaultFulfillmentMethod?: string | null;
  sourceFilter?: { enabled: boolean; keys: string[] } | null;
};

export type MapRowForEligibility = {
  source?: string | null;
  pushStatus?: string | null;
  ssShipmentId?: string | null;
};

export type PackedLineForEligibility = {
  packedItems?: { pickedItem?: { orderItem?: { item?: unknown } | null } | null }[] | null;
};

export const V1_MULTI_CONTAINER_REASON =
  'ShipStation V1 supports only one package per order, but this Sutton shipment has multiple pack containers.';

export const NO_DIGIT_CARRIER_REASON =
  'No Sutton shipping carrier is selected. Set the shipment carrier in Sutton to a mapped service, then try again.';

export type ShippingCarrierField = { id?: string | null; value?: string | null };

export type ShipmentForEligibility = {
  shippingStatus?: string | null;
  order?: {
    id?: string | null;
    shippingCarrierField?: ShippingCarrierField | null;
  } | null;
  packContainers?: PackedLineForEligibility[] | null;
  shippingCarrierField?: ShippingCarrierField | null;
};

export type CarrierMappingForEligibility = {
  ssCarrierCode?: string | null;
  ssServiceCode?: string | null;
  digitOptionId?: string | null;
  source?: string | null;
};

export type SsCarrierForEligibility = {
  carrierCode?: string | null;
  shipstationCarrierId?: string | null;
  name?: string | null;
  services?: { serviceCode?: string | null; name?: string | null }[] | null;
};

export type CarrierMapsForEligibility = {
  carrierMappings?: CarrierMappingForEligibility[] | null;
  mappings?: CarrierMappingForEligibility[] | null;
  ssCarriers?: SsCarrierForEligibility[] | null;
};

export type SsServiceResolve = {
  status: 'missing' | 'unmapped' | 'unconfirmed' | 'ambiguous' | 'ok';
  carrierId: string | null;
  carrierCode: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  digitOptionId: string | null;
  digitValue: string | null;
};

function mappingKey(ssCarrierCode: string, ssServiceCode = '') {
  return `${String(ssCarrierCode || '').trim()}\0${String(ssServiceCode || '').trim()}`;
}

/** Mirrors backend carrierMatch.resolveSsServiceFromDigitOption. */
export function resolveSsServiceFromDigitOption({
  digitOptionId,
  digitValue = null,
  mappings = [],
  ssCarriers = [],
}: {
  digitOptionId?: string | null;
  digitValue?: string | null;
  mappings?: CarrierMappingForEligibility[] | null;
  ssCarriers?: SsCarrierForEligibility[] | null;
}): SsServiceResolve {
  const optionId = digitOptionId != null ? String(digitOptionId).trim() : '';
  const blank = (status: SsServiceResolve['status']): SsServiceResolve => ({
    status,
    carrierId: null,
    carrierCode: null,
    serviceCode: null,
    serviceName: null,
    digitOptionId: optionId || null,
    digitValue: digitValue ? String(digitValue) : null,
  });
  if (!optionId) return blank('missing');

  const hits: { carrierCode: string; serviceCode: string; source: string | null }[] = [];
  for (const row of mappings ?? []) {
    if (!row?.digitOptionId || String(row.digitOptionId) !== optionId) continue;
    const serviceCode = String(row.ssServiceCode ?? '').trim();
    if (!serviceCode) continue;
    const carrierCode = String(row.ssCarrierCode || '').trim();
    if (!carrierCode) continue;
    hits.push({ carrierCode, serviceCode, source: row.source ?? null });
  }

  if (hits.length === 0) return blank('unmapped');

  const confirmed = hits.filter((hit) => hit.source === 'manual');
  if (confirmed.length === 0) return blank('unconfirmed');

  const uniqueKeys = new Set(confirmed.map((hit) => mappingKey(hit.carrierCode, hit.serviceCode)));
  if (uniqueKeys.size > 1) return blank('ambiguous');

  const hit = confirmed[0];
  const catalog =
    (ssCarriers ?? []).find((row) => String(row.carrierCode || '') === hit.carrierCode) ||
    (ssCarriers ?? []).find((row) => String(row.shipstationCarrierId || '') === hit.carrierCode) ||
    null;
  const service = (catalog?.services ?? []).find(
    (row) => String(row.serviceCode || '').trim() === hit.serviceCode,
  );
  return {
    status: 'ok',
    carrierId: catalog?.shipstationCarrierId ? String(catalog.shipstationCarrierId) : null,
    carrierCode: catalog?.carrierCode || hit.carrierCode,
    serviceCode: hit.serviceCode,
    serviceName: service?.name || hit.serviceCode,
    digitOptionId: optionId,
    digitValue: digitValue ? String(digitValue) : null,
  };
}

export function digitCarrierUnmappedReason(digitValue?: string | null) {
  const label = digitValue ? String(digitValue).trim() : '';
  if (label) {
    return `Sutton carrier "${label}" is not mapped to a ShipStation service. Map it in Carrier configuration, then try again.`;
  }
  return 'Sutton carrier is not mapped to a ShipStation service. Map it in Carrier configuration, then try again.';
}

export function digitCarrierUnconfirmedReason(digitValue?: string | null) {
  const label = digitValue ? String(digitValue).trim() : '';
  const who = label ? `Sutton carrier "${label}"` : 'Sutton carrier';
  return `${who} is only auto-matched to a ShipStation service. Confirm the service in Carrier configuration, then try again.`;
}

export function digitCarrierAmbiguousReason(digitValue?: string | null) {
  const label = digitValue ? String(digitValue).trim() : '';
  if (label) {
    return `Sutton carrier "${label}" maps to more than one ShipStation service. Keep service maps one-to-one.`;
  }
  return 'Sutton carrier maps to more than one ShipStation service. Keep service maps one-to-one.';
}

export function packedLineCount(shipment?: ShipmentForEligibility | null) {
  let count = 0;
  for (const container of shipment?.packContainers ?? []) {
    for (const packed of container.packedItems ?? []) {
      if (packed?.pickedItem?.orderItem?.item) count += 1;
    }
  }
  return count;
}

/** Shipment carrier if set; otherwise the parent sales order's current Digit carrier. */
export function effectiveShippingCarrierField(shipment?: ShipmentForEligibility | null) {
  const shipmentField = shipment?.shippingCarrierField;
  if (shipmentField?.id) return shipmentField;
  const orderField = shipment?.order?.shippingCarrierField;
  if (orderField?.id) return orderField;
  return shipmentField ?? orderField ?? null;
}

export function ineligibilityReason({
  shipment,
  orgSettings,
  mapRow,
  apiVersion = null,
  ssService = null,
  carrierMaps = null,
}: {
  shipment: ShipmentForEligibility;
  orgSettings?: OrgSettingsForEligibility | null;
  mapRow?: MapRowForEligibility | null;
  apiVersion?: string | null;
  ssService?: SsServiceResolve | null;
  carrierMaps?: CarrierMapsForEligibility | null;
}): string | null {
  void orgSettings;
  if (mapRow?.source === 'shipstation') {
    return 'This shipment was imported from ShipStation and will not be re-pushed.';
  }
  if (shipment?.shippingStatus === 'shipped') {
    return 'Already shipped in Sutton.';
  }
  // A ShipStation resource id is the durable guard: re-pushing would duplicate the SS shipment.
  if (
    mapRow &&
    (mapRow.ssShipmentId ||
      ['pushed', 'label_ready', 'shipped'].includes(mapRow.pushStatus ?? ''))
  ) {
    return mapRow.pushStatus === 'shipped'
      ? 'Already shipped in ShipStation.'
      : 'Already pushed to ShipStation.';
  }
  if (!shipment?.order?.id) {
    return 'This shipment is not linked to a sales order.';
  }
  if (packedLineCount(shipment) === 0) {
    return 'Shipment has no packed items.';
  }
  if (apiVersion === 'v1' && (shipment?.packContainers?.length ?? 0) > 1) {
    return V1_MULTI_CONTAINER_REASON;
  }

  const hasCarrierMaps = ssService != null || carrierMaps != null;
  const carrierField = effectiveShippingCarrierField(shipment);

  if (hasCarrierMaps) {
    const resolved =
      ssService ||
      resolveSsServiceFromDigitOption({
        digitOptionId: carrierField?.id ?? null,
        digitValue: carrierField?.value ?? null,
        mappings: carrierMaps?.carrierMappings ?? carrierMaps?.mappings ?? [],
        ssCarriers: carrierMaps?.ssCarriers ?? [],
      });

    if (resolved.status === 'missing') {
      return NO_DIGIT_CARRIER_REASON;
    }
    if (resolved.status === 'unmapped') {
      return digitCarrierUnmappedReason(resolved.digitValue || carrierField?.value);
    }
    if (resolved.status === 'unconfirmed') {
      return digitCarrierUnconfirmedReason(resolved.digitValue || carrierField?.value);
    }
    if (resolved.status === 'ambiguous') {
      return digitCarrierAmbiguousReason(resolved.digitValue || carrierField?.value);
    }
  } else if (!carrierField?.id) {
    return NO_DIGIT_CARRIER_REASON;
  }

  return null;
}

export function skipNextStep(reason: string | null | undefined) {
  if (!reason) return 'Fix the issue, then try again.';
  if (reason.includes('source is not selected in Settings')) {
    return 'Enable this source in Settings, or push it outside this app.';
  }
  if (reason.includes('imported from ShipStation')) {
    return 'Fulfill it in ShipStation; this app will not create a second shipment.';
  }
  if (reason.includes('Already shipped')) {
    return 'Download the label from this queue if you need it again. Tracking should already be on the Sutton shipment.';
  }
  if (reason.includes('Already pushed')) {
    return 'Buy the label in ShipStation, then pull from ShipStation or wait for the five-minute poll. This Sutton shipment stays until it is marked shipped.';
  }
  if (reason.includes('not linked to a sales order')) {
    return 'Multi-order or unlinked shipments are not pushed from this queue.';
  }
  if (reason.includes('no packed items')) {
    return 'Pack items onto this Sutton shipment, then try again.';
  }
  if (reason.includes('V1 supports only one package')) {
    return 'Create one Sutton shipment per pack container, or disconnect ShipStation and reconnect with V2 credentials.';
  }
  if (reason.includes('No Sutton shipping carrier is selected')) {
    return 'Open the Sutton shipment and set Shipping carrier to a service that is mapped in Carrier configuration.';
  }
  if (reason.includes('is not mapped to a ShipStation service')) {
    return 'Open Carrier configuration and map that Sutton option to exactly one ShipStation service.';
  }
  if (reason.includes('only auto-matched')) {
    return 'Open Carrier configuration, pick the ShipStation service for that Sutton carrier, and save.';
  }
  if (reason.includes('maps to more than one ShipStation service')) {
    return 'In Carrier configuration, keep each Sutton shipping carrier on a single ShipStation service row.';
  }
  if (reason.includes('no longer available in ShipStation')) {
    return 'On that shipment, pick another package type or choose Sutton dimensions, then push again.';
  }
  return 'Fix the issue above, then try again.';
}

export function digitShippingStatusLabel(value: string | null | undefined) {
  switch (String(value || '').toLowerCase()) {
    case 'awaiting_carrier':
      return 'Awaiting carrier';
    case 'awaiting_pickup':
      return 'Awaiting pickup';
    case 'awaiting_drop_off':
      return 'Awaiting drop-off';
    case 'shipped':
      return 'Shipped';
    case 'cancelled':
      return 'Cancelled';
    default:
      return value ? String(value).replace(/_/g, ' ') : '—';
  }
}

export function digitShippingStatusChip(value: string | null | undefined): {
  label: string;
  color: QueuePushDisplay['chipColor'];
} | null {
  const label = digitShippingStatusLabel(value);
  if (label === '—') return null;
  const status = String(value || '').toLowerCase();
  if (status === 'shipped') return { label, color: 'success' };
  if (status === 'cancelled') return { label, color: 'error' };
  if (status.startsWith('awaiting')) return { label, color: 'info' };
  return { label, color: 'default' };
}

export function trackingStatusLabel(value: string | null | undefined) {
  switch (String(value || '').toLowerCase()) {
    case 'unknown':
      return 'Unknown';
    case 'in_transit':
      return 'In transit';
    case 'delivered':
      return 'Delivered';
    case 'delivered_to_service_point':
      return 'Delivered to service point';
    case 'error':
    case 'exception':
      return 'Error';
    case 'voided':
      return 'Voided';
    default:
      return value ? String(value).replace(/_/g, ' ') : null;
  }
}

export function shipStationLabelStatusLabel(mapRow?: {
  trackingStatus?: string | null;
  ssLabelId?: string | null;
  hasLabel?: boolean | null;
  ssShipmentId?: string | null;
} | null) {
  const tracking = trackingStatusLabel(mapRow?.trackingStatus);
  if (tracking) return tracking;
  if (mapRow?.hasLabel || mapRow?.ssLabelId) return 'Purchased';
  if (mapRow?.ssShipmentId) return 'Awaiting label';
  return '—';
}

export function trackingStatusChip(mapRow?: {
  trackingStatus?: string | null;
  ssLabelId?: string | null;
  hasLabel?: boolean | null;
  ssShipmentId?: string | null;
} | null): { label: string; color: QueuePushDisplay['chipColor'] } | null {
  const label = shipStationLabelStatusLabel(mapRow);
  if (label === '—') return null;
  const tracking = String(mapRow?.trackingStatus || '').toLowerCase();
  if (tracking === 'error' || tracking === 'exception') return { label, color: 'error' };
  if (tracking === 'delivered' || tracking === 'delivered_to_service_point') {
    return { label, color: 'success' };
  }
  if (tracking === 'in_transit') return { label, color: 'info' };
  if (mapRow?.hasLabel || mapRow?.ssLabelId) return { label, color: 'success' };
  if (mapRow?.ssShipmentId) return { label, color: 'info' };
  return { label, color: 'default' };
}

export function pushStatusLabel(value: string | null | undefined) {
  switch (value) {
    case 'pushed':
      return 'In ShipStation — awaiting label';
    case 'label_ready':
      return 'Label found — not yet written to Sutton';
    case 'skipped':
      return 'Not pushed';
    case 'error':
      return 'Push failed';
    case 'shipped':
      return 'Shipped — tracking written back';
    case 'imported':
      return 'Imported from ShipStation';
    case 'pending':
      return 'Pending';
    default:
      return value ? value.replace(/_/g, ' ') : 'Not pushed yet';
  }
}

export type QueuePushDisplay = {
  primary: string;
  chipColor: 'success' | 'warning' | 'error' | 'info' | 'default';
  tooltip: string;
  showPrimaryAsChip: boolean;
  lastError?: string | null;
  /** Rejected create: the schedule will not retry; the operator must push the row. */
  manualRetry?: boolean;
};

/** Keep in sync with src/backend/eligibility.js */
export const MANUAL_PUSH_RETRY_MEANING =
  'The shipment was not created in ShipStation. It will not retry on its own. Update the shipment data, then select this row and push again.';

export type QueueSyncState = 'shipped' | 'imported' | 'label_ready' | 'pushed';

/** A ShipStation id means the push landed, whatever a later skip wrote to push_status. */
export function queueSyncState({
  mapRow,
  shippingStatus,
}: {
  mapRow?: {
    pushStatus?: string | null;
    ssShipmentId?: string | null;
  } | null;
  shippingStatus?: string | null;
}): QueueSyncState | null {
  const pushStatus = mapRow?.pushStatus;
  if (shippingStatus === 'shipped' || pushStatus === 'shipped') return 'shipped';
  if (pushStatus === 'imported') return 'imported';
  if (pushStatus === 'label_ready') return 'label_ready';
  if (pushStatus === 'pushed' || mapRow?.ssShipmentId) return 'pushed';
  return null;
}

/** Group order for the queue's push-status view. Tracking labels stay on the row. */
export const PUSH_STATUS_GROUP_ORDER = [
  'ready',
  'blocked',
  'error',
  'pushed',
  'label_ready',
  'imported',
  'shipped',
] as const;

export function queuePushGroup({
  blocked,
  mapRow,
  shippingStatus,
}: {
  blocked: string | null;
  mapRow?: {
    pushStatus?: string | null;
    lastError?: string | null;
    ssShipmentId?: string | null;
  } | null;
  shippingStatus?: string | null;
}): { key: string; label: string } {
  const syncState = queueSyncState({ mapRow, shippingStatus });
  if (syncState === 'pushed') return { key: 'pushed', label: pushStatusLabel('pushed') };
  if (syncState === 'label_ready') return { key: 'label_ready', label: pushStatusLabel('label_ready') };
  if (syncState === 'imported') return { key: 'imported', label: pushStatusLabel('imported') };
  if (syncState === 'shipped') return { key: 'shipped', label: pushStatusLabel('shipped') };
  if (mapRow?.lastError || mapRow?.pushStatus === 'error') {
    return { key: 'error', label: 'Push failed' };
  }
  if (blocked) return { key: 'blocked', label: 'Blocked' };
  return { key: 'ready', label: 'Ready' };
}

/** Single queue column: eligibility (ready/blocked) or ShipStation sync state — not both. */
export function queuePushDisplay({
  blocked,
  mapRow,
  shippingStatus,
}: {
  blocked: string | null;
  mapRow?: {
    pushStatus?: string | null;
    lastError?: string | null;
    ssShipmentId?: string | null;
    trackingStatus?: string | null;
  } | null;
  shippingStatus?: string | null;
}): QueuePushDisplay {
  const lastError = mapRow?.lastError ?? null;
  const syncState = queueSyncState({ mapRow, shippingStatus });

  if (syncState) {
    const trackingLabel = trackingStatusLabel(mapRow?.trackingStatus);
    const primary = trackingLabel || pushStatusLabel(syncState);
    return {
      primary,
      chipColor:
        mapRow?.trackingStatus === 'error' || mapRow?.trackingStatus === 'exception'
          ? 'error'
          : mapRow?.trackingStatus === 'delivered' ||
              mapRow?.trackingStatus === 'delivered_to_service_point' ||
              syncState === 'shipped'
            ? 'success'
            : mapRow?.trackingStatus === 'in_transit' || syncState === 'pushed' || syncState === 'label_ready'
              ? 'info'
              : 'default',
      tooltip:
        trackingLabel
          ? `ShipStation tracking status: ${trackingLabel}.`
          : syncState === 'pushed'
            ? `${pushStatusLabel(syncState)} Buy the label in ShipStation, then pull from ShipStation or wait up to five minutes.`
            : syncState === 'label_ready'
              ? `${pushStatusLabel(syncState)} Press Pull from ShipStation to write the carrier and tracking onto this shipment.`
              : pushStatusLabel(syncState),
      showPrimaryAsChip: true,
    };
  }

  if (lastError || mapRow?.pushStatus === 'error') {
    return {
      primary: lastError ?? pushStatusLabel('error'),
      chipColor: 'error',
      tooltip: lastError ? `Push failed. ${lastError}` : 'Push failed.',
      showPrimaryAsChip: true,
      lastError: null,
      manualRetry: true,
    };
  }

  if (blocked) {
    return {
      primary: 'Blocked',
      chipColor: 'warning',
      tooltip: `${blocked} ${skipNextStep(blocked)}`,
      showPrimaryAsChip: true,
    };
  }

  return {
    primary: 'Ready',
    chipColor: 'success',
    tooltip: 'Eligible to push.',
    showPrimaryAsChip: true,
  };
}
