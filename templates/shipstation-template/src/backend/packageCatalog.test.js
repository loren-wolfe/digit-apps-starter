import assert from 'node:assert/strict';
import test from 'node:test';

import { d1InsertChunkSize, missingCatalogTargets, packageCatalogConnectionsDue, planPackageCatalogWrites } from './packageCatalog.js';

function row(overrides = {}) {
  return {
    id: 1,
    source: 'carrier',
    ss_carrier_id: 'se-ups',
    carrier_code: 'ups',
    package_code: 'package',
    package_id: null,
    package_name: 'Package',
    description: null,
    length: null,
    width: null,
    height: null,
    dimension_unit: null,
    deleted: 0,
    ...overrides,
  };
}

function pkg(overrides = {}) {
  return {
    source: 'carrier',
    carrierId: 'se-ups',
    carrierCode: 'ups',
    packageCode: 'package',
    name: 'Package',
    ...overrides,
  };
}

test('catalog inserts stay under D1’s bound-parameter limit', () => {
  assert.equal(d1InsertChunkSize(12) * 12 <= 100, true);
  assert.equal(d1InsertChunkSize(6) * 6 <= 100, true);
  assert.equal(d1InsertChunkSize(12), 8);
});

test('missing catalog targets are the requested carriers not already stored', () => {
  const storedCarriers = [
    { shipstation_carrier_id: 'se-ups', carrier_code: 'ups' },
    { shipstation_carrier_id: 'se-fedex', carrier_code: 'fedex' },
  ];
  const storedGroups = [{ carrierId: 'se-ups', carrierCode: 'ups', packages: [{ packageCode: 'package' }] }];
  assert.deepEqual(
    missingCatalogTargets({
      apiVersion: 'v2',
      carrierIds: ['se-ups', 'se-fedex'],
      storedCarriers,
      storedGroups,
    }).map((target) => target.carrierId),
    ['se-fedex'],
  );
});

test('package catalog writes insert, skip unchanged rows, update, and retire', () => {
  const kept = row();
  const renamed = row({ id: 2, package_code: 'ups_box', package_name: 'Old box' });
  const gone = row({ id: 3, package_code: 'ups_tube' });
  const plan = planPackageCatalogWrites({
    existing: [kept, renamed, gone, row({ id: 4, package_code: 'deleted_box', deleted: 1 })],
    incoming: [
      pkg(),
      pkg({ packageCode: 'ups_box', name: 'UPS box' }),
      pkg({ packageCode: 'ups_letter', name: 'UPS letter' }),
      pkg({ packageCode: '', name: 'blank' }),
    ],
  });
  assert.deepEqual(
    plan.insert.map((item) => item.packageCode),
    ['ups_letter'],
  );
  assert.deepEqual(
    plan.update.map((item) => item.id),
    [2],
  );
  assert.deepEqual(plan.retire, [3]);
});

test('package catalog refresh runs at night and bootstraps one new connection', () => {
  const night = new Date('2026-09-23T07:00:00.000Z');
  const day = new Date('2026-09-23T18:00:00.000Z');
  const rows = [
    { connection_id: 1, pulled_on: '2026-09-23', last_attempt_at: '2026-09-23 07:00:00' },
    { connection_id: 2, pulled_on: '2026-09-22', last_attempt_at: '2026-09-22 07:00:00' },
    { connection_id: 3, pulled_on: null, last_attempt_at: null },
    { connection_id: 4, pulled_on: null, last_attempt_at: null },
  ];
  const nightly = packageCatalogConnectionsDue({ rows, now: night });
  assert.equal(nightly.night, true);
  assert.equal(nightly.today, '2026-09-23');
  assert.deepEqual(
    nightly.due.map((row) => row.connection_id),
    [2, 3, 4],
  );
  const bootstrap = packageCatalogConnectionsDue({ rows, now: day });
  assert.equal(bootstrap.skipped, false);
  assert.deepEqual(
    bootstrap.due.map((row) => row.connection_id),
    [3],
  );
  const waited = packageCatalogConnectionsDue({
    rows: [{ connection_id: 3, pulled_on: null, last_attempt_at: '2026-09-23 18:00:00' }],
    now: day,
  });
  assert.equal(waited.skipped, true);
  const retry = packageCatalogConnectionsDue({
    rows: [{ connection_id: 3, pulled_on: null, last_attempt_at: '2026-09-23 17:00:00' }],
    now: day,
  });
  assert.deepEqual(
    retry.due.map((row) => row.connection_id),
    [3],
  );
});
