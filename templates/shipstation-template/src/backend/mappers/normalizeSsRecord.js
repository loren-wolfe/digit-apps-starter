/**
 * Normalize V1 order / V2 shipment / label payloads into one fulfillment shape
 * used by sync writeback and inbound import.
 */

import { trackingStatusFromSsRecord } from './digitShippingStatus.js';

/**
 * @returns {{
 *   ssShipmentId: string | null,
 *   externalId: string | null,
 *   labelId: string | null,
 *   trackingNumber: string | null,
 *   carrierCode: string | null,
 *   serviceCode: string | null,
 *   trackingStatus: string | null,
 *   shipDate: string | null,
 *   costAmount: number | null,
 *   costCurrency: string | null,
 *   shipmentNumber: string | null,
 *   items: Array<{ sku: string, name?: string, quantity: number, unitPrice: number | null }>,
 *   shipTo: object | null,
 *   billTo: object | null,
 *   raw: object,
 * }}
 */
export function normalizeSsRecord(record) {
  if (!record || typeof record !== 'object') {
    return emptyNormalized(record);
  }

  // V1 order (orderId / orderKey)
  if (record.orderId != null || record.orderKey != null || record.orderNumber != null) {
    const labelShipment = v1LabelShipment(record);
    const tracking =
      labelShipment?.trackingNumber ||
      record.trackingNumber ||
      null;
    const shipDate =
      labelShipment?.shipDate ||
      record.shipDate ||
      record.orderDate ||
      null;
    return {
      ssShipmentId: record.orderId != null ? String(record.orderId) : null,
      externalId: record.orderKey ? String(record.orderKey) : null,
      labelId: null,
      trackingNumber: tracking ? String(tracking) : null,
      trackingStatus: trackingStatusFromSsRecord(record),
      carrierCode: labelShipment?.carrierCode || record.carrierCode || null,
      serviceCode: labelShipment?.serviceCode || record.serviceCode || null,
      shipDate: shipDate ? String(shipDate) : null,
      costAmount:
        typeof record.shippingAmount === 'number'
          ? record.shippingAmount
          : record.shippingAmount != null
            ? Number(record.shippingAmount)
            : null,
      costCurrency: null,
      shipmentNumber: record.orderNumber ? String(record.orderNumber) : null,
      items: (record.items ?? [])
        .map((item) => ({
          sku: String(item.sku || item.fulfillmentSku || '').trim(),
          name: item.name,
          quantity: Number(item.quantity) || 1,
          unitPrice: finiteNumber(item.unitPrice ?? item.unit_price ?? item.price),
        }))
        .filter((item) => item.sku),
      shipTo: normalizeV1Address(record.shipTo),
      billTo: normalizeV1Address(record.billTo || record.shipTo),
      raw: record,
    };
  }

  // V2 shipment / label
  const cost = record.shipment_cost || record.shipmentCost;
  const tracking =
    record.tracking_number ||
    record.trackingNumber ||
    record.packages?.[0]?.tracking_number ||
    null;

  return {
    ssShipmentId:
      record.shipment_id != null
        ? String(record.shipment_id)
        : record.shipmentId != null
          ? String(record.shipmentId)
          : null,
    externalId:
      record.external_shipment_id ||
      record.externalShipmentId ||
      null,
    labelId:
      record.label_id != null
        ? String(record.label_id)
        : record.labelId != null
          ? String(record.labelId)
          : null,
    trackingNumber: tracking ? String(tracking) : null,
    trackingStatus: trackingStatusFromSsRecord(record),
    carrierCode:
      record.carrier_code ||
      record.carrierCode ||
      record.carrier_id ||
      record.carrierId ||
      null,
    serviceCode: record.service_code || record.serviceCode || null,
    shipDate: record.ship_date || record.shipDate || record.created_at || null,
    costAmount: cost?.amount ?? null,
    costCurrency: cost?.currency ?? null,
    shipmentNumber: record.shipment_number || record.shipmentNumber || null,
    items: (record.items ?? [])
      .map((item) => ({
        sku: String(item.sku || item.fullfilment_sku || '').trim(),
        name: item.name,
        quantity: Number(item.quantity) || 1,
        unitPrice: finiteNumber(item.unit_price ?? item.unitPrice ?? item.price),
      }))
      .filter((item) => item.sku),
    shipTo: normalizeV2Address(record.ship_to || record.shipTo),
    billTo: normalizeV2Address(record.bill_to || record.billTo || record.ship_to),
    raw: record,
  };
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Digit CostInput for packing slips / sales-order PDFs (`UpdateOrderInput.shippingFees`). */
export function shippingFeesInput({ amount, currency }) {
  const costAmount = finiteNumber(amount);
  if (costAmount == null || costAmount < 0) return null;
  const raw = String(currency || 'USD').trim();
  return { currencyCode: raw ? raw.toUpperCase() : 'USD', costAmount };
}

/**
 * Sutton shipping-carrier option printed on the sales-order packing slip.
 * The PDF reads the order field. The purchased ShipStation label wins over the
 * SHP field, which often still holds the carrier selected on the sales order
 * before the label was bought. Rows are newest shipment first.
 */
export function packingSlipCarrierChoice(rows) {
  for (const row of rows ?? []) {
    const resolved = String(row?.resolvedOptionId || '').trim();
    const shipment = String(row?.shipmentOptionId || '').trim();
    const optionId = resolved || shipment;
    if (!optionId) continue;
    const shipmentId = String(row?.digitShipmentId || '').trim();
    return { optionId, shipmentId: shipmentId || null };
  }
  return { optionId: null, shipmentId: null };
}

export function packingSlipCarrierOptionId(rows) {
  return packingSlipCarrierChoice(rows).optionId;
}

/** V1 label row. The order header can still name the carrier requested at push. */
function v1LabelShipment(record) {
  const shipments = Array.isArray(record?.shipments) ? record.shipments : [];
  return (
    shipments.find((entry) => entry?.trackingNumber || entry?.carrierCode || entry?.serviceCode) ||
    null
  );
}

/** Sum label postage stored on D1 map rows for one Digit sales order. */
export function summedShippingFees(rows) {
  let total = 0;
  let currency = null;
  let found = false;
  for (const row of rows ?? []) {
    const amount = finiteNumber(row?.shipment_cost_amount ?? row?.shipmentCostAmount);
    if (amount == null || amount < 0) continue;
    found = true;
    total += amount;
    const code = row?.shipment_cost_currency ?? row?.shipmentCostCurrency;
    if (code) currency = code;
  }
  if (!found) return null;
  return shippingFeesInput({ amount: total, currency });
}

function emptyNormalized(raw) {
  return {
    ssShipmentId: null,
    externalId: null,
    labelId: null,
    trackingNumber: null,
    trackingStatus: null,
    carrierCode: null,
    serviceCode: null,
    shipDate: null,
    costAmount: null,
    costCurrency: null,
    shipmentNumber: null,
    items: [],
    shipTo: null,
    billTo: null,
    raw: raw || null,
  };
}

function normalizeV1Address(address) {
  if (!address) return null;
  return {
    name: address.name,
    company_name: address.company,
    address_line1: address.street1,
    address_line2: address.street2,
    city_locality: address.city,
    state_province: address.state,
    postal_code: address.postalCode,
    country_code: address.country,
  };
}

function normalizeV2Address(address) {
  if (!address) return null;
  return {
    name: address.name,
    company_name: address.company_name || address.companyName,
    address_line1: address.address_line1 || address.addressLine1,
    address_line2: address.address_line2 || address.addressLine2,
    city_locality: address.city_locality || address.cityLocality,
    state_province: address.state_province || address.stateProvince,
    postal_code: address.postal_code || address.postalCode,
    country_code: address.country_code || address.countryCode,
  };
}

/**
 * Shape expected by shipStationToDigit mappers (V2 field names).
 */
export function normalizedToImportShipment(normalized) {
  return {
    shipment_id: normalized.ssShipmentId,
    external_shipment_id: normalized.externalId,
    shipment_number: normalized.shipmentNumber,
    ship_to: normalized.shipTo,
    bill_to: normalized.billTo,
    items: normalized.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    carrier_code: normalized.carrierCode,
    service_code: normalized.serviceCode,
    advanced_options: {},
  };
}
