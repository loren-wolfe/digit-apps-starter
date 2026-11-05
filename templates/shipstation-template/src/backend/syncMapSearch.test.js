import assert from 'node:assert/strict';
import test from 'node:test';

import { mapSearchLikePattern, queryMapsBySearch } from './mapSearch.js';

function mapRow(overrides = {}) {
  return {
    connection_id: 'conn-1',
    deleted: 0,
    digit_order_id: 'order-1',
    digit_shipment_id: 'shp-1',
    ss_shipment_id: 'se-100',
    ss_label_id: null,
    source: 'digit',
    push_status: 'pushed',
    last_error: null,
    tracking_number: '1Z999',
    tracking_status: null,
    carrier_name: 'UPS',
    ship_date: null,
    shipment_cost_amount: null,
    shipment_cost_currency: null,
    has_label_pdf: 0,
    ...overrides,
  };
}

function likeNeedle(pattern) {
  const inner = pattern.slice(1, -1);
  return inner.replace(/\\([\\%_])/g, '$1').toLowerCase();
}

function fakeDb(rows) {
  return {
    prepare(sql) {
      return {
        bind(connectionId, pattern, patternAgain) {
          return {
            async all() {
              assert.match(sql, /ss_shipment_id/);
              assert.match(sql, /tracking_number/);
              assert.match(sql, /deleted = 0/);
              assert.match(sql, /ESCAPE '\\'/);
              assert.equal(pattern, patternAgain);
              const needle = likeNeedle(pattern);
              const matched = rows.filter((row) => {
                if (row.connection_id !== connectionId || row.deleted !== 0) return false;
                return [row.ss_shipment_id, row.tracking_number].some((value) =>
                  String(value ?? '').toLowerCase().includes(needle),
                );
              });
              return { results: matched.slice(0, 25) };
            },
          };
        },
      };
    },
  };
}

test('mapSearchLikePattern keeps LIKE wildcards literal', () => {
  assert.equal(mapSearchLikePattern('  '), null);
  assert.equal(mapSearchLikePattern('se-100'), '%se-100%');
  assert.equal(mapSearchLikePattern('100%'), '%100\\%%');
  assert.equal(mapSearchLikePattern('a_b'), '%a\\_b%');
  assert.equal(mapSearchLikePattern('a\\b'), '%a\\\\b%');
});

test('mapsMatchingQuery matches ShipStation id and tracking, and skips other rows', async () => {
  const rows = [
    mapRow(),
    mapRow({
      digit_shipment_id: 'shp-track',
      ss_shipment_id: 'se-other',
      tracking_number: '9400111899',
    }),
    mapRow({
      digit_shipment_id: 'shp-deleted',
      ss_shipment_id: 'se-100-deleted',
      deleted: 1,
    }),
    mapRow({
      connection_id: 'conn-2',
      digit_shipment_id: 'shp-other-org',
      ss_shipment_id: 'se-100-other',
    }),
    mapRow({
      digit_shipment_id: 'shp-carrier-only',
      ss_shipment_id: 'se-999',
      tracking_number: 'DIFFERENT',
      carrier_name: 'se-100 carrier name',
    }),
  ];
  const db = fakeDb(rows);
  const search = (query) =>
    queryMapsBySearch({
      db,
      connectionId: 'conn-1',
      query,
      selectSql: 'SELECT digit_shipment_id, ss_shipment_id, tracking_number FROM shipstation_order_map',
      mapRow: (row) => row,
    });

  assert.deepEqual(await search('   '), []);

  const byId = await search('SE-100');
  assert.deepEqual(
    byId.map((row) => row.digit_shipment_id),
    ['shp-1'],
  );
  assert.equal(byId[0].ss_shipment_id, 'se-100');

  const byTracking = await search('940011');
  assert.deepEqual(
    byTracking.map((row) => row.digit_shipment_id),
    ['shp-track'],
  );

  const literalPercent = await search('100%');
  assert.deepEqual(literalPercent, []);
});
