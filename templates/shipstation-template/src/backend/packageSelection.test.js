import assert from 'node:assert/strict';
import test from 'node:test';

import { skipNeedsAttention, skipNextStep } from './eligibility.js';
import {
  catalogFailureMessage,
  catalogPullMessage,
  packageListTargets,
  packageSeenKey,
  pulledPackagesFromRecord,
  unresolvedCarrierCodes,
  unseenPackages,
} from './packageCatalog.js';
import {
  isStaleCarrierSelection,
  matchPulledPackages,
  missingPackageTypeReason,
  packageObservationChanged,
  resolvePushPackageSelections,
} from './packageSelection.js';

const ups = { status: 'ok', carrierId: 'se-ups', carrierCode: 'ups' };
const fedex = { status: 'ok', carrierId: 'se-fedex', carrierCode: 'fedex' };

test('clears a carrier package when the mapped carrier changes and keeps custom packages', () => {
  const custom = {
    digitContainerId: 'c1',
    source: 'custom',
    packageCode: 'custom_laptop_box',
    packageName: 'Laptop box',
  };
  const carrier = {
    digitContainerId: 'c2',
    source: 'carrier',
    packageCode: 'fedex_small_box',
    packageName: 'FedEx Small Box',
    ssCarrierId: 'se-fedex',
    ssCarrierCode: 'fedex',
  };
  assert.equal(isStaleCarrierSelection(carrier, ups), true);
  assert.equal(isStaleCarrierSelection(custom, ups), false);

  const resolved = resolvePushPackageSelections({
    selections: [custom, carrier],
    carrier: ups,
    customPackages: [
      {
        packageCode: 'custom_laptop_box',
        packageId: 'se-102873',
        dimensions: { length: 15, width: 20, height: 5, unit: 'inch' },
      },
    ],
    carrierPackages: [{ packageCode: 'ups_express_box', packageId: null, dimensions: null }],
  });
  assert.deepEqual(
    resolved.stale.map((row) => row.digitContainerId),
    ['c2'],
  );
  assert.equal(resolved.missing, null);
  assert.deepEqual(resolved.overridesByContainerId.c1, {
    packageCode: 'custom_laptop_box',
    packageId: 'se-102873',
    dimensions: { length: 15, width: 20, height: 5, unit: 'inch' },
  });
  assert.equal(resolved.overridesByContainerId.c2, undefined);
});

test('a saved type missing from the catalog skips push with an operator-facing reason', () => {
  const selection = {
    digitContainerId: 'c1',
    source: 'custom',
    packageCode: 'custom_gone',
    packageName: 'Old laptop box',
  };
  const resolved = resolvePushPackageSelections({
    selections: [selection],
    carrier: ups,
    customPackages: [],
    carrierPackages: [],
  });
  assert.equal(resolved.missing, selection);
  const reason = missingPackageTypeReason(selection);
  assert.match(reason, /Old laptop box is no longer available in ShipStation/);
  assert.equal(skipNeedsAttention(reason), true);
  assert.match(skipNextStep(reason), /Sutton dimensions/);
});

test('pull matches V2 packages by external package id and does not guess when several lack ids', () => {
  const matched = matchPulledPackages({
    containerIds: ['c1', 'c2'],
    packages: [
      { externalPackageId: 'c2', packageCode: 'fedex_large_box' },
      { externalPackageId: 'c1', packageCode: 'custom_mailer' },
    ],
  });
  assert.deepEqual(
    matched.map((row) => [row.digitContainerId, row.pkg.packageCode]),
    [
      ['c2', 'fedex_large_box'],
      ['c1', 'custom_mailer'],
    ],
  );

  assert.deepEqual(
    matchPulledPackages({
      containerIds: ['c1', 'c2'],
      packages: [{ packageCode: 'a' }, { packageCode: 'b' }],
    }),
    [],
  );
});

test('a single V1 package updates the one Sutton container', () => {
  const packages = pulledPackagesFromRecord(
    {
      packageCode: 'flat_rate_envelope',
      weight: { value: 6, units: 'ounces' },
      dimensions: { length: 12, width: 9, height: 1, units: 'inches' },
    },
    'v1',
  );
  const matches = matchPulledPackages({ containerIds: ['c1'], packages });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].digitContainerId, 'c1');
  assert.equal(matches[0].pkg.packageCode, 'flat_rate_envelope');
  assert.equal(matches[0].pkg.weight.unit, 'ounce');
  assert.deepEqual(matches[0].pkg.dimensions, { length: 12, width: 9, height: 1, unit: 'inch' });
  assert.equal(packageObservationChanged(null, matches[0].pkg), true);
  assert.equal(
    packageObservationChanged(
      {
        packageCode: 'flat_rate_envelope',
        packageName: 'flat_rate_envelope',
        packageId: null,
        length: 12,
        width: 9,
        height: 1,
        dimensionUnit: 'inch',
        weightValue: 6,
        weightUnit: 'ounce',
        observedFromShipstation: true,
      },
      matches[0].pkg,
    ),
    false,
  );
});

test('resolves V2 carrier package lists from carrier codes when the queue has no carrier id', () => {
  const stored = [
    { shipstation_carrier_id: 'se-stamps', carrier_code: 'stamps_com' },
    { shipstation_carrier_id: 'se-ups', carrier_code: 'ups' },
  ];
  assert.deepEqual(
    packageListTargets({
      apiVersion: 'v2',
      carrierIds: [],
      carrierCodes: ['stamps_com'],
      storedCarriers: stored,
    }),
    [{ carrierId: 'se-stamps', carrierCode: 'stamps_com' }],
  );
  assert.deepEqual(
    packageListTargets({
      apiVersion: 'v1',
      carrierCodes: ['stamps_com'],
      storedCarriers: stored,
    }),
    [{ carrierId: null, carrierCode: 'stamps_com' }],
  );
});

test('unresolved carrier codes are the ones missing from the stored catalog', () => {
  const stored = [{ shipstation_carrier_id: 'se-ups', carrier_code: 'ups', name: 'UPS' }];
  assert.deepEqual(unresolvedCarrierCodes({ carrierCodes: ['ups', 'fedex'], storedCarriers: stored }), [
    'fedex',
  ]);
  assert.deepEqual(unresolvedCarrierCodes({ carrierCodes: ['se-ups'], storedCarriers: stored }), []);
});

test('catalog failure message names the ShipStation error', () => {
  assert.equal(
    catalogFailureMessage([
      {
        scope: 'carrier',
        carrierName: 'UPS',
        message: 'ShipStation did not respond in time. Try again in a moment.',
      },
    ]),
    'Could not pull UPS package types from ShipStation: ShipStation did not respond in time. Try again in a moment.',
  );
  assert.match(
    catalogFailureMessage([{ scope: 'custom', message: 'Could not list custom packages.' }]),
    /custom package types/,
  );
});

test('catalog pull message names new carriers and packages', () => {
  assert.equal(
    catalogPullMessage({
      kind: 'carriers',
      items: [{ name: 'Stamps.com' }],
    }),
    'Pulled 1 new carrier from ShipStation: Stamps.com.',
  );
  assert.equal(
    catalogPullMessage({
      kind: 'packages',
      items: [
        { name: 'Small Flat Rate Box', carrierName: 'Stamps.com' },
        { name: 'Laptop box' },
      ],
    }),
    'Pulled 2 new packages from ShipStation: Small Flat Rate Box (Stamps.com), Laptop box.',
  );
});

test('a package already seen for this connection is not logged again', () => {
  const known = packageSeenKey({
    source: 'carrier',
    carrierId: 'se-stamps',
    packageCode: 'small_flat_rate_box',
  });
  const added = unseenPackages(
    [known],
    [
      { source: 'carrier', carrierId: 'se-stamps', packageCode: 'small_flat_rate_box', name: 'Small' },
      { source: 'carrier', carrierId: 'se-stamps', packageCode: 'flat_rate_envelope', name: 'Envelope' },
    ],
  );
  assert.deepEqual(
    added.map((pkg) => pkg.packageCode),
    ['flat_rate_envelope'],
  );
});
