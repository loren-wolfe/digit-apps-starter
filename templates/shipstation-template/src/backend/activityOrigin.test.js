import assert from 'node:assert/strict';
import test from 'node:test';

import { inferActivityOrigin } from './activityOrigin.js';
import { suttonUpdateMessage } from './activity.js';

test('Sutton sales order and shipment updates name the object', () => {
  assert.equal(
    suttonUpdateMessage({
      kind: 'shipment',
      label: 'SHP-12',
      changes: ['shipping status shipped', 'shipping carrier'],
    }),
    'Updated Sutton shipment SHP-12: shipping status shipped, shipping carrier.',
  );
  assert.equal(
    suttonUpdateMessage({
      kind: 'order',
      label: 'SO25',
      changes: ['shipping fees 20.98 USD'],
    }),
    'Updated Sutton sales order SO25: shipping fees 20.98 USD.',
  );
  assert.equal(
    suttonUpdateMessage({
      verb: 'Created',
      kind: 'order',
      label: 'SO25',
      ok: false,
      message: 'Sutton API request failed.',
    }),
    'Could not create Sutton sales order SO25: Sutton API request failed.',
  );
});

test('catalog pull is recorded by this app', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'catalog_pull',
      status: 'success',
      message: 'Pulled 1 new carrier from ShipStation: Stamps.com.',
    }),
    'app',
  );
});

test('graphql detail and Sutton API wording are Sutton', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'push_error',
      status: 'error',
      message: 'Sutton API request failed (HTTP 502).',
      detail: { graphqlCode: 'INTERNAL_SERVER_ERROR' },
    }),
    'sutton',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'push_error',
      status: 'error',
      message: 'Sutton shipment not found.',
    }),
    'sutton',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'push_error',
      status: 'error',
      message: 'Digit API rate limit reached.',
    }),
    'sutton',
  );
});

test('a missing shipment id is ShipStation', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'push_error',
      status: 'error',
      message: 'ShipStation did not return a shipment id.',
    }),
    'shipstation',
  );
});

test('ShipStation error detail wins even when the message omits the name', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'push_error',
      status: 'error',
      message: 'A shipping address is required.',
      detail: { httpStatus: 400, requestId: 'req_1', errorCodes: ['invalid_address'] },
    }),
    'shipstation',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'poll',
      status: 'error',
      message: 'Could not read ShipStation labels for se-1: upstream failed.',
      detail: { queried: 'labels', httpStatus: 500, requestId: null, errorCodes: [] },
    }),
    'shipstation',
  );
});

test('a Sutton failure while staging a ShipStation label stays Sutton', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'poll',
      status: 'error',
      message: 'Staging ShipStation label se-9 failed: Sutton API request failed (HTTP 502).',
      detail: { code: 'UPSTREAM_ERROR' },
    }),
    'sutton',
  );
});

test('app decisions that mention both names stay this app', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'carrier_unmapped',
      status: 'warning',
      message:
        'ShipStation usps_priority did not match a Sutton shipping carrier. Map it in carrier settings.',
    }),
    'app',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'push_skip',
      status: 'skipped',
      message: 'Shipment is not awaiting carrier.',
    }),
    'app',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'poll',
      status: 'error',
      message:
        'ShipStation secrets are V2 but this connection was opened as V1. Disconnect and reconnect to switch API versions.',
    }),
    'app',
  );
});

test('channel actor and downloads follow the system that served them', () => {
  assert.equal(
    inferActivityOrigin({
      actor: 'channel',
      action: 'channel.fulfillment',
      status: 'error',
      message: 'Shopify fulfillment failed.',
    }),
    'channel',
  );
  assert.equal(
    inferActivityOrigin({ action: 'label_download', status: 'error', message: 'Label download failed.' }),
    'shipstation',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'packing_slip_download',
      status: 'error',
      message: 'Packing slip download failed.',
    }),
    'sutton',
  );
});

test('errors with no system signal stay unknown, and an explicit origin is kept', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'poll',
      status: 'error',
      message: 'Staging the label threw before it could finish.',
      detail: { code: 'UPSTREAM_ERROR' },
    }),
    'unknown',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'poll',
      status: 'error',
      message: 'Anything',
      detail: { origin: 'sutton' },
    }),
    'sutton',
  );
});

test('routine success without an upstream signal is this app', () => {
  assert.equal(
    inferActivityOrigin({
      action: 'settings',
      status: 'success',
      message: 'Saved settings (push manual, default weight 16 oz).',
    }),
    'app',
  );
  assert.equal(
    inferActivityOrigin({
      action: 'push',
      status: 'success',
      message: 'Created ShipStation shipment se-1 for SO-10.',
    }),
    'app',
  );
});
