import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANUAL_SOURCE,
  normalizeSourceFilter,
  shipmentSourceKey,
  sourceExcluded,
  sourceLabel,
} from './sourceFilter.js';

function shipmentFrom(connection) {
  return {
    id: 'ship-1',
    order: { id: 'order-1', ...(connection === undefined ? {} : { externalOrder: connection ? { connection } : null }) },
  };
}

const shopify = { id: 'conn-shopify', platform: 'SHOPIFY', storeUniqueName: 'sound-skins.myshopify.com' };
const amazon = { id: 'conn-amazon', platform: 'AMAZON', storeUniqueName: null };

test('orders without an external order are manual entry', () => {
  assert.equal(shipmentSourceKey(shipmentFrom(undefined)), MANUAL_SOURCE);
  assert.equal(shipmentSourceKey(shipmentFrom(null)), MANUAL_SOURCE);
  assert.equal(shipmentSourceKey({ order: { externalOrder: { connection: null } } }), MANUAL_SOURCE);
  assert.equal(shipmentSourceKey(null), MANUAL_SOURCE);
  assert.equal(shipmentSourceKey(shipmentFrom(shopify)), 'conn-shopify');
});

test('filter off never excludes', () => {
  const orgSettings = { sourceFilter: { enabled: false, keys: ['conn-shopify'] } };
  assert.equal(sourceExcluded({ shipment: shipmentFrom(amazon), orgSettings }), false);
  assert.equal(sourceExcluded({ shipment: shipmentFrom(amazon), orgSettings: {} }), false);
  assert.equal(sourceExcluded({ shipment: shipmentFrom(amazon), orgSettings: null }), false);
});

test('filter on routes only selected sources', () => {
  const orgSettings = { sourceFilter: { enabled: true, keys: ['conn-shopify'] } };
  assert.equal(sourceExcluded({ shipment: shipmentFrom(shopify), orgSettings }), false);
  assert.equal(sourceExcluded({ shipment: shipmentFrom(amazon), orgSettings }), true);
  assert.equal(sourceExcluded({ shipment: shipmentFrom(null), orgSettings }), true);

  const withManual = { sourceFilter: { enabled: true, keys: [MANUAL_SOURCE] } };
  assert.equal(sourceExcluded({ shipment: shipmentFrom(null), orgSettings: withManual }), false);
  assert.equal(sourceExcluded({ shipment: shipmentFrom(shopify), orgSettings: withManual }), true);
});

test('shipments already in ShipStation stay visible', () => {
  const orgSettings = { sourceFilter: { enabled: true, keys: ['conn-shopify'] } };
  const shipment = shipmentFrom(amazon);
  assert.equal(sourceExcluded({ shipment, orgSettings, mapRow: { ssShipmentId: 'se-1' } }), false);
  assert.equal(sourceExcluded({ shipment, orgSettings, mapRow: { pushStatus: 'shipped' } }), false);
  assert.equal(sourceExcluded({ shipment, orgSettings, mapRow: { push_status: 'label_ready' } }), false);
  assert.equal(sourceExcluded({ shipment, orgSettings, mapRow: { pushStatus: 'error' } }), true);
});

test('labels lead with the commerce platform', () => {
  assert.equal(sourceLabel(shopify), 'Shopify · Sound Skins');
  assert.equal(sourceLabel({ platform: 'SHOPIFY', storeUniqueName: null }), 'Shopify');
  assert.equal(sourceLabel(amazon), 'Amazon');
  assert.equal(sourceLabel({ platform: 'WOO_COMMERCE' }), 'WooCommerce');
  assert.equal(sourceLabel(null), 'Manual Entry');
});

test('stored filter parses defensively', () => {
  assert.deepEqual(normalizeSourceFilter(1, '["a","b","a"]'), { enabled: true, keys: ['a', 'b'] });
  assert.deepEqual(normalizeSourceFilter(1, 'not json'), { enabled: false, keys: [] });
  assert.deepEqual(normalizeSourceFilter(1, '[]'), { enabled: false, keys: [] });
  assert.deepEqual(normalizeSourceFilter(0, '["a"]'), { enabled: false, keys: ['a'] });
  assert.deepEqual(normalizeSourceFilter(undefined, undefined), { enabled: false, keys: [] });
});
