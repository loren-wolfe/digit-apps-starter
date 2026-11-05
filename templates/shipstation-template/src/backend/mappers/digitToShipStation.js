/**
 * Digit sales order → ShipStation V2 shipment body.
 * Override skuForLine in a customer clone for branded SKUs (CS-04).
 */

import {
  packageFromOrgSettings,
  packagesFromDigitShipment,
} from './packageMapping.js';

export { packageFromOrgSettings } from './packageMapping.js';

export function skuForLine(line) {
  return String(line?.customerSku || line?.item?.sku || '').trim();
}

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

function addressFromDigit(address, { name, companyName, phone, email }) {
  return {
    name: name || address?.title || companyName || 'Ship to',
    phone: phone || '000-000-0000',
    email: email || undefined,
    company_name: companyName || undefined,
    address_line1: address?.addressLineOne || '—',
    address_line2: address?.addressLineTwo || undefined,
    city_locality: address?.city || '',
    state_province: address?.state || '',
    postal_code: address?.zip || '',
    country_code: countryCode(address?.country),
    address_residential_indicator: 'unknown',
  };
}

function billToNote({ billingAddress, customerName }) {
  if (!billingAddress) return customerName ? `Bill-to: ${customerName}` : '';
  const parts = [
    customerName,
    billingAddress.title,
    billingAddress.addressLineOne,
    billingAddress.addressLineTwo,
    [billingAddress.city, billingAddress.state, billingAddress.zip].filter(Boolean).join(', '),
    billingAddress.country,
  ].filter(Boolean);
  return parts.length ? `Bill-to: ${parts.join(' · ')}` : '';
}

export function packedLinesFromShipment(shipment) {
  const linesById = new Map();
  for (const container of shipment?.packContainers ?? []) {
    for (const packed of container.packedItems ?? []) {
      const orderItem = packed?.pickedItem?.orderItem;
      if (!orderItem?.item) continue;
      const id = String(orderItem.id ?? '');
      const quantity = Number(packed.quantity ?? orderItem.quantity);
      const existing = linesById.get(id);
      if (existing) {
        existing.quantity += Number.isFinite(quantity) ? quantity : 1;
        continue;
      }
      linesById.set(id, {
        id: orderItem.id,
        quantity: Number.isFinite(quantity) ? quantity : 1,
        customerSku: orderItem.customerSku,
        item: orderItem.item,
      });
    }
  }
  return [...linesById.values()];
}

/** V1 weight object (`units: ounces`). */
export function v1WeightFromOrgSettings(orgSettings) {
  const pkg = packageFromOrgSettings(orgSettings);
  return { value: pkg.weight.value, units: 'ounces' };
}

/**
 * @param {{
 *   shipment: object,
 *   shipFrom: object,
 *   orgSettings?: object | null,
 *   carrierId?: string | null,
 *   serviceCode?: string | null,
 *   packageSelections?: object | null,
 * }} args
 */
export function digitShipmentToShipment({
  shipment,
  shipFrom,
  orgSettings = null,
  carrierId = null,
  serviceCode = null,
  packageSelections = null,
}) {
  const order = shipment?.order;
  const customerName = order?.customer?.name || '';
  const shipAddress = shipment?.shippingAddress || order?.shippingAddress;
  const shipToName =
    order?.customerContact?.fullName || shipAddress?.title || customerName;

  const items = packedLinesFromShipment(shipment).map((line) => ({
    name: line.item.name || skuForLine(line) || 'Item',
    sku: skuForLine(line) || undefined,
    quantity: Math.max(1, Math.round(Number(line.quantity) || 1)),
    external_order_id: order?.id,
    external_order_item_id: line.id,
  }));

  const externalId = String(shipment?.id || '').slice(0, 50);
  const note = billToNote({
    billingAddress: order?.billingAddress,
    customerName,
  });

  const resolvedCarrierId = carrierId ? String(carrierId).trim() : '';
  const resolvedServiceCode = serviceCode ? String(serviceCode).trim() : '';

  return {
    external_shipment_id: externalId,
    shipment_number:
      shipment?.documentNumber ||
      shipment?.shippingNumber ||
      order?.documentNumber ||
      order?.orderNumber ||
      externalId,
    create_sales_order: true,
    ship_to: addressFromDigit(shipAddress, {
      name: shipToName,
      companyName: customerName,
    }),
    ship_from: shipFrom,
    items,
    packages: packagesFromDigitShipment(shipment, orgSettings, packageSelections),
    internal_notes: [order?.notes, shipment?.notes, note].filter(Boolean).join('\n').slice(0, 1000) || undefined,
    ...(resolvedCarrierId ? { carrier_id: resolvedCarrierId } : {}),
    ...(resolvedServiceCode ? { service_code: resolvedServiceCode } : {}),
  };
}

/**
 * @param {{ order: object, shipFrom: object }} args
 * @deprecated Prefer digitShipmentToShipment for the shipping queue.
 */
export function digitOrderToShipment({ order, shipFrom }) {
  return digitShipmentToShipment({
    shipment: {
      id: order?.id,
      documentNumber: order?.documentNumber,
      shippingNumber: order?.orderNumber,
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
    shipFrom,
  });
}

export function orgShipFrom({ organization }) {
  const addresses = organization?.addresses ?? [];
  const shipFrom =
    addresses.find((address) => address.isShipFromDefault) ||
    addresses.find((address) => address.isManufacturingDefault) ||
    addresses[0];
  return addressFromDigit(shipFrom, {
    name: organization?.name || 'Warehouse',
    companyName: organization?.name,
    email: organization?.replyToEmail,
  });
}
