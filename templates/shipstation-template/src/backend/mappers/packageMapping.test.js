import assert from 'node:assert/strict';
import test from 'node:test';

import {
  V1_MULTI_CONTAINER_REASON,
  ineligibilityReason,
  skipNextStep,
} from '../eligibility.js';
import {
  digitShipmentToShipment,
  packedLinesFromShipment,
} from './digitToShipStation.js';
import { digitShipmentToV1Order } from './digitToShipStationV1.js';
import {
  packageFromDigitContainer,
  packagesFromDigitShipment,
} from './packageMapping.js';

function measurement(value, symbol, name = symbol) {
  return { value, uom: { symbol, name } };
}

function packedItem(id, quantity) {
  return {
    quantity,
    pickedItem: {
      orderItem: {
        id,
        quantity,
        customerSku: `customer-${id}`,
        item: { id: `item-${id}`, name: `Item ${id}`, sku: `sku-${id}` },
      },
    },
  };
}

const orgSettings = {
  defaultWeightOz: 12,
  defaultLengthIn: 9,
  defaultWidthIn: 7,
  defaultHeightIn: 5,
};

test('maps each Digit pack container to a V2 package with normalized measurements', () => {
  const packages = packagesFromDigitShipment(
    {
      packContainers: [
        {
          id: 'container-1',
          packageGrossWeight: measurement(2, 'lb'),
          packageLength: measurement(25.4, 'cm'),
          packageWidth: measurement(254, 'mm'),
          packageHeight: measurement(0.254, 'm'),
        },
        {
          id: 'container-2',
          packageGrossWeight: measurement(500, 'g'),
        },
      ],
    },
    orgSettings,
  );

  assert.equal(packages.length, 2);
  assert.deepEqual(packages[0], {
    package_code: 'package',
    external_package_id: 'container-1',
    weight: { value: 32, unit: 'ounce' },
    dimensions: { length: 10, width: 10, height: 10, unit: 'inch' },
  });
  assert.deepEqual(packages[1], {
    package_code: 'package',
    external_package_id: 'container-2',
    weight: { value: 17.636981, unit: 'ounce' },
    dimensions: { length: 9, width: 7, height: 5, unit: 'inch' },
  });
});

test('falls back to package defaults when container measurements are missing or invalid', () => {
  assert.deepEqual(packageFromDigitContainer({ id: 'container-1' }, orgSettings), {
    package_code: 'package',
    external_package_id: 'container-1',
    weight: { value: 12, unit: 'ounce' },
    dimensions: { length: 9, width: 7, height: 5, unit: 'inch' },
  });

  assert.deepEqual(packageFromDigitContainer({}, null), {
    package_code: 'package',
    weight: { value: 16, unit: 'ounce' },
  });
});

test('aggregates a Digit order item split across containers into one ShipStation item', () => {
  const shipment = {
    id: 'shipment-1',
    documentNumber: 'SHP-1',
    shippingAddress: {},
    order: { id: 'order-1', customer: { name: 'Customer' } },
    packContainers: [
      { id: 'container-1', packedItems: [packedItem('line-1', 2)] },
      {
        id: 'container-2',
        packedItems: [packedItem('line-1', 3), packedItem('line-2', 1)],
      },
    ],
  };

  assert.deepEqual(
    packedLinesFromShipment(shipment).map(({ id, quantity }) => ({ id, quantity })),
    [
      { id: 'line-1', quantity: 5 },
      { id: 'line-2', quantity: 1 },
    ],
  );

  const payload = digitShipmentToShipment({
    shipment,
    shipFrom: { name: 'Warehouse' },
    orgSettings,
  });
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].quantity, 5);
  assert.equal(payload.packages.length, 2);
  assert.deepEqual(
    payload.packages.map((pkg) => pkg.external_package_id),
    ['container-1', 'container-2'],
  );
});

test('maps a single Digit container to V1 order-level package fields', () => {
  const order = digitShipmentToV1Order({
    shipment: {
      id: 'shipment-1',
      documentNumber: 'SHP-1',
      createdAt: '2026-09-16T00:00:00.000Z',
      shippingAddress: {},
      order: { id: 'order-1', customer: { name: 'Customer' } },
      packContainers: [
        {
          id: 'container-1',
          packageGrossWeight: measurement(1.5, 'kg'),
          packageLength: measurement(10, 'in'),
          packageWidth: measurement(8, 'in'),
          packageHeight: measurement(6, 'in'),
          packedItems: [packedItem('line-1', 1)],
        },
      ],
    },
    orgSettings,
  });

  assert.equal(order.packageCode, 'package');
  assert.deepEqual(order.weight, { value: 52.910943, units: 'ounces' });
  assert.deepEqual(order.dimensions, {
    length: 10,
    width: 8,
    height: 6,
    units: 'inches',
  });
});

test('selected package type sends its code and dimensions and keeps Sutton weight', () => {
  const container = {
    id: 'container-1',
    packageGrossWeight: measurement(2, 'lb'),
    packageLength: measurement(4, 'in'),
    packageWidth: measurement(4, 'in'),
    packageHeight: measurement(4, 'in'),
  };
  assert.deepEqual(
    packageFromDigitContainer(container, orgSettings, {
      packageCode: 'custom_laptop_box',
      packageId: 'se-102873',
      dimensions: { length: 15, width: 20, height: 5, unit: 'inch' },
    }),
    {
      package_code: 'custom_laptop_box',
      package_id: 'se-102873',
      external_package_id: 'container-1',
      weight: { value: 32, unit: 'ounce' },
      dimensions: { length: 15, width: 20, height: 5, unit: 'inch' },
    },
  );
});

test('a selected type with no dimensions omits dimensions instead of sending Sutton dimensions', () => {
  const pkg = packageFromDigitContainer(
    {
      id: 'container-1',
      packageGrossWeight: measurement(1, 'lb'),
      packageLength: measurement(12, 'in'),
      packageWidth: measurement(10, 'in'),
      packageHeight: measurement(8, 'in'),
    },
    orgSettings,
    { packageCode: 'fedex_small_box', packageId: 'not-a-shipstation-id' },
  );
  assert.equal(pkg.package_code, 'fedex_small_box');
  assert.equal(pkg.package_id, undefined);
  assert.equal(pkg.dimensions, undefined);
  assert.deepEqual(pkg.weight, { value: 16, unit: 'ounce' });
});

test('V1 selected package type uses the catalog code and omits dimensions when the type has none', () => {
  const order = digitShipmentToV1Order({
    shipment: {
      id: 'shipment-1',
      documentNumber: 'SHP-1',
      createdAt: '2026-09-16T00:00:00.000Z',
      shippingAddress: {},
      order: { id: 'order-1', customer: { name: 'Customer' } },
      packContainers: [
        {
          id: 'container-1',
          packageGrossWeight: measurement(8, 'oz'),
          packageLength: measurement(10, 'in'),
          packageWidth: measurement(8, 'in'),
          packageHeight: measurement(6, 'in'),
          packedItems: [packedItem('line-1', 1)],
        },
      ],
    },
    orgSettings,
    packageSelection: { packageCode: 'flat_rate_envelope' },
  });
  assert.equal(order.packageCode, 'flat_rate_envelope');
  assert.equal(order.dimensions, undefined);
  assert.deepEqual(order.weight, { value: 8, units: 'ounces' });
});

test('blocks multi-container shipments on V1 with actionable guidance', () => {
  const shipment = {
    order: { id: 'order-1' },
    shippingCarrierField: { id: 'opt-ups-gnd', value: 'UPS Ground' },
    packContainers: [
      { packedItems: [packedItem('line-1', 1)] },
      { packedItems: [packedItem('line-2', 1)] },
    ],
  };
  const ssService = {
    status: 'ok',
    carrierId: 'se-ups-1',
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    serviceName: 'UPS Ground',
    digitOptionId: 'opt-ups-gnd',
    digitValue: 'UPS Ground',
  };

  const reason = ineligibilityReason({
    shipment,
    orgSettings,
    mapRow: null,
    apiVersion: 'v1',
    ssService,
  });
  assert.equal(reason, V1_MULTI_CONTAINER_REASON);
  assert.match(skipNextStep(reason), /one Sutton shipment per pack container/);
  assert.equal(
    ineligibilityReason({
      shipment,
      orgSettings,
      mapRow: null,
      apiVersion: 'v2',
      ssService,
    }),
    null,
  );
});
