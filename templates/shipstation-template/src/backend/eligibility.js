import { resolveSsServiceFromDigitOption } from './carrierMatch.js';

const FULFILLMENT_METHODS = new Set(['scheduled', 'manual']);
export { FULFILLMENT_METHODS };

export const V1_MULTI_CONTAINER_REASON =
  'ShipStation V1 supports only one package per order, but this Sutton shipment has multiple pack containers.';

export const NO_DIGIT_CARRIER_REASON =
  'No Sutton shipping carrier is selected. Set the shipment carrier in Sutton to a mapped service, then try again.';

/** Explicit scheduled stays scheduled; unspecified / leftover values → manual (the default). */
export function normalizeFulfillmentMethod(value) {
  return value === 'scheduled' ? 'scheduled' : 'manual';
}

export function packedLineCount(shipment) {
  let count = 0;
  for (const container of shipment?.packContainers ?? []) {
    for (const packed of container.packedItems ?? []) {
      if (packed?.pickedItem?.orderItem?.item) count += 1;
    }
  }
  return count;
}

/** Shipment carrier if set; otherwise the parent sales order's current Digit carrier. */
export function effectiveShippingCarrierField(shipment) {
  const shipmentField = shipment?.shippingCarrierField;
  if (shipmentField?.id) return shipmentField;
  const orderField = shipment?.order?.shippingCarrierField;
  if (orderField?.id) return orderField;
  return shipmentField ?? orderField ?? null;
}

export function digitCarrierUnmappedReason(digitValue) {
  const label = digitValue ? String(digitValue).trim() : '';
  if (label) {
    return `Sutton carrier "${label}" is not mapped to a ShipStation service. Map it in Carrier configuration, then try again.`;
  }
  return 'Sutton carrier is not mapped to a ShipStation service. Map it in Carrier configuration, then try again.';
}

export function digitCarrierUnconfirmedReason(digitValue) {
  const label = digitValue ? String(digitValue).trim() : '';
  const who = label ? `Sutton carrier "${label}"` : 'Sutton carrier';
  return `${who} is only auto-matched to a ShipStation service. Confirm the service in Carrier configuration, then try again.`;
}

export function digitCarrierAmbiguousReason(digitValue) {
  const label = digitValue ? String(digitValue).trim() : '';
  if (label) {
    return `Sutton carrier "${label}" maps to more than one ShipStation service. Keep service maps one-to-one.`;
  }
  return 'Sutton carrier maps to more than one ShipStation service. Keep service maps one-to-one.';
}

/**
 * Why a Digit shipment is not pushed. Null means eligible.
 * Pass `ssService` (from resolveSsServiceFromDigitOption) or `carrierMaps` for the UI.
 */
export function ineligibilityReason({
  shipment,
  orgSettings,
  mapRow,
  apiVersion = null,
  ssService = null,
  carrierMaps = null,
}) {
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
    (mapRow.ssShipmentId || ['pushed', 'label_ready', 'shipped'].includes(mapRow.pushStatus))
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

  const hasCarrierMaps =
    ssService != null ||
    carrierMaps != null;

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

/**
 * A rejected create with no ShipStation id. The scheduled sweep must leave it alone;
 * the operator pushes the row again after updating the shipment. Not an eligibility block.
 */
export function failedPushNeedsManualRetry(mapRow) {
  if (!mapRow) return false;
  const status = mapRow.pushStatus ?? mapRow.push_status ?? null;
  const ssShipmentId = mapRow.ssShipmentId ?? mapRow.ss_shipment_id ?? null;
  return status === 'error' && !ssShipmentId;
}

/** Keep in sync with src/frontend/eligibility.ts */
export const MANUAL_PUSH_RETRY_MEANING =
  'The shipment was not created in ShipStation. It will not retry on its own. Update the shipment data, then select this row and push again.';

/**
 * True when a skipped push is the operator's problem to fix. Sweep runs (the five-minute poll)
 * stay quiet about routine skips like already-pushed shipments.
 */
export function skipNeedsAttention(reason) {
  if (!reason) return false;
  return (
    reason === NO_DIGIT_CARRIER_REASON ||
    reason === V1_MULTI_CONTAINER_REASON ||
    reason.includes('ShipStation service') ||
    reason.includes('ShipStation carrier id is missing') ||
    reason.includes('no longer available in ShipStation')
  );
}

/** Keep in sync with src/frontend/eligibility.ts */
export function skipNextStep(reason) {
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
