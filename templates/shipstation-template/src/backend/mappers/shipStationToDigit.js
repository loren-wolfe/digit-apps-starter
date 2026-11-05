/**
 * ShipStation V2 shipment → Digit createOrder inputs.
 * Bill-to company is the Digit customer; ship-to is a company location (drop-ship).
 */

function digitsOnlyPhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function ssCompanyName(shipment) {
  return (
    shipment?.advanced_options?.bill_to_party ||
    shipment?.bill_to?.company_name ||
    shipment?.ship_to?.company_name ||
    shipment?.ship_to?.name ||
    'ShipStation customer'
  );
}

export function ssShipToLocationInput({ companyId, shipment }) {
  const to = shipment?.ship_to ?? {};
  return {
    companyId,
    title: to.name || to.company_name || 'Ship to',
    addressLineOne: to.address_line1 || undefined,
    addressLineTwo: to.address_line2 || undefined,
    city: to.city_locality || undefined,
    state: to.state_province || undefined,
    zip: to.postal_code || undefined,
    country: to.country_code || undefined,
    isShippingDefault: false,
    isBillingDefault: false,
  };
}

export function ssBillingAddressInput(shipment) {
  const bill = shipment?.bill_to ?? shipment?.ship_to ?? {};
  return {
    title: bill.company_name || bill.name || 'Billing',
    addressLineOne: bill.address_line1 || undefined,
    addressLineTwo: bill.address_line2 || undefined,
    city: bill.city_locality || undefined,
    state: bill.state_province || undefined,
    zip: bill.postal_code || undefined,
    country: bill.country_code || undefined,
  };
}

export function ssLineSkus(shipment) {
  return (shipment?.items ?? [])
    .map((item) => ({
      sku: String(item.sku || item.fullfilment_sku || '').trim(),
      name: item.name,
      quantity: Number(item.quantity) || 1,
      unitPrice: finiteNumber(item.unitPrice ?? item.unit_price ?? item.price),
    }))
    .filter((item) => item.sku);
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export { digitsOnlyPhone };
