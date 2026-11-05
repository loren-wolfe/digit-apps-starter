import assert from 'node:assert/strict';
import test from 'node:test';

import { salesOrderStatusAfterLabelReturn } from './salesOrderStatus.js';

const current = { id: 'shp-current', shippingStatus: 'awaiting_pickup' };

test('one shipment on the sales order is fulfilled', () => {
  assert.equal(
    salesOrderStatusAfterLabelReturn({
      shipments: [current],
      currentShipmentId: current.id,
    }),
    'fulfilled',
  );
});

test('all other shipments shipped is fulfilled', () => {
  assert.equal(
    salesOrderStatusAfterLabelReturn({
      shipments: [
        current,
        { id: 'shp-2', shippingStatus: 'shipped' },
        { id: 'shp-3', shippingStatus: 'shipped' },
      ],
      currentShipmentId: current.id,
    }),
    'fulfilled',
  );
});

for (const shippingStatus of [
  'awaiting_carrier',
  'awaiting_drop_off',
  'awaiting_pickup',
  'cancelled',
]) {
  test(`a sibling still ${shippingStatus} is partially fulfilled`, () => {
    assert.equal(
      salesOrderStatusAfterLabelReturn({
        shipments: [current, { id: 'shp-2', shippingStatus: 'shipped' }, { id: 'shp-3', shippingStatus }],
        currentShipmentId: current.id,
      }),
      'partially_fulfilled',
    );
  });
}

test('a voided current shipment does not change the sales order', () => {
  assert.equal(
    salesOrderStatusAfterLabelReturn({
      shipments: [
        { id: 'shp-current', shippingStatus: 'cancelled' },
        { id: 'shp-2', shippingStatus: 'shipped' },
      ],
      currentShipmentId: 'shp-current',
    }),
    null,
  );
});
