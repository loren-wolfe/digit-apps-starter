/**
 * Digit shipment → ShipStation V1 order body (POST /orders/createorder).
 */

import { packedLinesFromShipment, skuForLine } from './digitToShipStation.js';
import { v1PackageFieldsFromDigitContainer } from './packageMapping.js';

function countryCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'US';
  if (raw.length === 2) return raw.toUpperCase();
  const lower = raw.toLowerCase();
  if (lower === 'united states' || lower === 'usa' || lower === 'us') return 'US';
  if (lower === 'canada' || lower === 'ca') return 'CA';
  if (lower === 'mexico' || lower === 'mx') return 'MX';
  return raw.slice(0, 2).toUpperCase() || 'US';
}

function v1Address(address, { name, companyName, phone }) {
  return {
    name: name || address?.title || companyName || 'Ship to',
    company: companyName || null,
    street1: address?.addressLineOne || '—',
    street2: address?.addressLineTwo || null,
    street3: null,
    city: address?.city || '',
    state: address?.state || '',
    postalCode: address?.zip || '',
    country: countryCode(address?.country),
    phone: phone || '000-000-0000',
    residential: null,
  };
}

/**
 * @param {{
 *   shipment: object,
 *   orgSettings?: object | null,
 *   carrierCode?: string | null,
 *   serviceCode?: string | null,
 *   packageSelection?: object | null,
 * }} args
 */
export function digitShipmentToV1Order({
  shipment,
  orgSettings = null,
  carrierCode = null,
  serviceCode = null,
  packageSelection = null,
}) {
  const order = shipment?.order;
  const customerName = order?.customer?.name || '';
  const shipAddress = shipment?.shippingAddress || order?.shippingAddress;
  const shipToName =
    order?.customerContact?.fullName || shipAddress?.title || customerName;
  const orderKey = String(shipment?.id || order?.id || '').slice(0, 50);
  const orderNumber = String(
    shipment?.documentNumber ||
      shipment?.shippingNumber ||
      order?.documentNumber ||
      order?.orderNumber ||
      orderKey,
  ).slice(0, 50);
  const orderDate =
    order?.orderDate ||
    shipment?.createdAt ||
    order?.createdAt ||
    order?.created_at ||
    new Date().toISOString();

  const items = packedLinesFromShipment(shipment).map((line) => ({
    lineItemKey: String(line.id),
    sku: skuForLine(line) || undefined,
    name: line.item.name || skuForLine(line) || 'Item',
    quantity: Math.max(1, Math.round(Number(line.quantity) || 1)),
    unitPrice: Number(line.unitPrice ?? line.price ?? 0) || 0,
  }));

  const resolvedCarrierCode = carrierCode ? String(carrierCode).trim() : '';
  const resolvedServiceCode = serviceCode ? String(serviceCode).trim() : '';

  return {
    orderNumber,
    orderKey,
    orderDate,
    orderStatus: 'awaiting_shipment',
    customerEmail: order?.customerContact?.email || order?.customer?.email || undefined,
    billTo: v1Address(order?.billingAddress || shipAddress, {
      name: customerName || shipToName,
      companyName: customerName,
    }),
    shipTo: v1Address(shipAddress, {
      name: shipToName,
      companyName: customerName,
    }),
    ...v1PackageFieldsFromDigitContainer(
      shipment?.packContainers?.[0],
      orgSettings,
      packageSelection,
    ),
    items,
    internalNotes: [order?.notes, shipment?.notes].filter(Boolean).join('\n').slice(0, 1000) || undefined,
    ...(resolvedCarrierCode ? { carrierCode: resolvedCarrierCode } : {}),
    ...(resolvedServiceCode ? { serviceCode: resolvedServiceCode } : {}),
  };
}

/**
 * @param {{ order: object }} args
 * @deprecated Prefer digitShipmentToV1Order for the shipping queue.
 */
export function digitOrderToV1Order({ order }) {
  return digitShipmentToV1Order({
    shipment: {
      id: order?.id,
      documentNumber: order?.documentNumber,
      shippingNumber: order?.orderNumber,
      createdAt: order?.createdAt || order?.created_at,
      shippingAddress: order?.shippingAddress,
      notes: order?.notes,
      order,
      packContainers: [
        {
          packedItems: (order?.items ?? [])
            .filter((line) => line?.item)
            .map((line) => ({
              quantity: line.quantity,
              pickedItem: { orderItem: line },
            })),
        },
      ],
    },
  });
}
