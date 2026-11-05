import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSsRecord,
  packingSlipCarrierOptionId,
  shippingFeesInput,
  summedShippingFees,
} from './normalizeSsRecord.js';

test('shippingFeesInput uppercases ShipStation currency for Digit CostInput', () => {
  assert.deepEqual(shippingFeesInput({ amount: 177.34, currency: 'usd' }), {
    currencyCode: 'USD',
    costAmount: 177.34,
  });
});

test('shippingFeesInput rejects missing amounts', () => {
  assert.equal(shippingFeesInput({ amount: null, currency: 'usd' }), null);
  assert.equal(shippingFeesInput({ amount: -1, currency: 'usd' }), null);
});

test('summedShippingFees totals postage for one Digit order', () => {
  assert.deepEqual(
    summedShippingFees([
      { shipment_cost_amount: 10.5, shipment_cost_currency: 'usd' },
      { shipment_cost_amount: 2, shipment_cost_currency: 'usd' },
    ]),
    { currencyCode: 'USD', costAmount: 12.5 },
  );
});

test('packingSlipCarrierOptionId prefers the ShipStation label over the SHP field', () => {
  assert.equal(
    packingSlipCarrierOptionId([
      { shipmentOptionId: 'shp-fedex', resolvedOptionId: 'ss-usps' },
    ]),
    'ss-usps',
  );
});

test('packingSlipCarrierOptionId uses the SHP carrier when the label does not resolve', () => {
  assert.equal(
    packingSlipCarrierOptionId([
      { shipmentOptionId: null, resolvedOptionId: null },
      { shipmentOptionId: 'shp-usps', resolvedOptionId: null },
    ]),
    'shp-usps',
  );
});

test('normalizeSsRecord uses the V1 label shipment carrier, not the pushed order carrier', () => {
  const normalized = normalizeSsRecord({
    orderId: 100,
    orderNumber: 'SO25',
    carrierCode: 'fedex',
    serviceCode: 'fedex_2day',
    shipments: [
      {
        carrierCode: 'stamps_com',
        serviceCode: 'usps_ground_advantage',
        trackingNumber: '9334689956300000408818',
      },
    ],
  });
  assert.equal(normalized.carrierCode, 'stamps_com');
  assert.equal(normalized.serviceCode, 'usps_ground_advantage');
  assert.equal(normalized.trackingNumber, '9334689956300000408818');
});

test('packingSlipCarrierOptionId skips unlabeled rows and returns null when nothing maps', () => {
  assert.equal(
    packingSlipCarrierOptionId([
      { shipmentOptionId: '', resolvedOptionId: null },
      { shipmentOptionId: 'shp-usps', resolvedOptionId: null },
    ]),
    'shp-usps',
  );
  assert.equal(packingSlipCarrierOptionId([]), null);
  assert.equal(packingSlipCarrierOptionId(null), null);
});

test('summedShippingFees is null when no label costs exist', () => {
  assert.equal(summedShippingFees([{ shipment_cost_amount: null }]), null);
  assert.equal(summedShippingFees([]), null);
});
