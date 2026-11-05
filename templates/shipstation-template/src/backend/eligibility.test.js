import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectiveShippingCarrierField,
  failedPushNeedsManualRetry,
  ineligibilityReason,
  MANUAL_PUSH_RETRY_MEANING,
  NO_DIGIT_CARRIER_REASON,
} from './eligibility.js';

function packedShipment(overrides = {}) {
  return {
    shippingStatus: 'awaiting_carrier',
    packContainers: [
      { packedItems: [{ pickedItem: { orderItem: { item: { id: 'item-1' } } } }] },
    ],
    order: { id: 'order-1' },
    ...overrides,
  };
}

const upsMaps = {
  carrierMappings: [
    {
      ssCarrierCode: 'ups',
      ssServiceCode: 'ups_ground',
      digitOptionId: 'opt-ups-gnd',
      source: 'manual',
    },
  ],
  ssCarriers: [
    {
      carrierCode: 'ups',
      shipstationCarrierId: 'se-1',
      name: 'UPS',
      services: [{ serviceCode: 'ups_ground', name: 'UPS Ground' }],
    },
  ],
};

test('effectiveShippingCarrierField prefers the shipment carrier', () => {
  const field = effectiveShippingCarrierField({
    shippingCarrierField: { id: 'ship', value: 'Shipment UPS' },
    order: { shippingCarrierField: { id: 'ord', value: 'Order FedEx' } },
  });
  assert.equal(field?.id, 'ship');
  assert.equal(field?.value, 'Shipment UPS');
});

test('effectiveShippingCarrierField falls back to the sales order carrier', () => {
  const field = effectiveShippingCarrierField({
    shippingCarrierField: null,
    order: { shippingCarrierField: { id: 'ord', value: 'Order FedEx' } },
  });
  assert.equal(field?.id, 'ord');
  assert.equal(field?.value, 'Order FedEx');
});

test('ineligibilityReason uses the order carrier when the shipment carrier is empty', () => {
  const reason = ineligibilityReason({
    shipment: packedShipment({
      shippingCarrierField: null,
      order: { id: 'order-1', shippingCarrierField: { id: 'opt-ups-gnd', value: 'UPS Ground' } },
    }),
    carrierMaps: upsMaps,
  });
  assert.equal(reason, null);
});

test('ineligibilityReason still blocks when neither shipment nor order has a carrier', () => {
  const reason = ineligibilityReason({
    shipment: packedShipment({ shippingCarrierField: null }),
    carrierMaps: { carrierMappings: [], ssCarriers: [] },
  });
  assert.equal(reason, NO_DIGIT_CARRIER_REASON);
});

test('a failed push with no ShipStation id stays eligible for a manual retry', () => {
  const reason = ineligibilityReason({
    shipment: packedShipment({
      shippingCarrierField: { id: 'opt-ups-gnd', value: 'UPS Ground' },
    }),
    mapRow: { pushStatus: 'error', lastError: 'Invalid address', ssShipmentId: null },
    carrierMaps: upsMaps,
  });
  assert.equal(reason, null);
});

test('failedPushNeedsManualRetry is only a rejected create with no ShipStation id', () => {
  assert.equal(failedPushNeedsManualRetry({ pushStatus: 'error', ssShipmentId: null }), true);
  assert.equal(failedPushNeedsManualRetry({ push_status: 'error', ss_shipment_id: null }), true);
  assert.equal(failedPushNeedsManualRetry({ pushStatus: 'error', ssShipmentId: 'se-1' }), false);
  assert.equal(failedPushNeedsManualRetry({ pushStatus: 'pushed', ssShipmentId: null }), false);
  assert.equal(failedPushNeedsManualRetry(null), false);
  assert.equal(
    MANUAL_PUSH_RETRY_MEANING,
    'The shipment was not created in ShipStation. It will not retry on its own. Update the shipment data, then select this row and push again.',
  );
});
