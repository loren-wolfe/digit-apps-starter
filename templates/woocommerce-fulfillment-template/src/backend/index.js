/**
 * WooCommerce fulfillment Worker.
 *
 * D1: WOOCOMMERCE_FULFILLMENT_DB
 * Required: API_TOKEN_SUTTON, WC_CONSUMER_KEY, WC_CONSUMER_SECRET (secrets), WC_STORE_URL (env).
 * Fulfillment warehouse: chosen on the Configuration tab (fulfillment_settings.warehouse_location_id).
 * WAREHOUSE_LOCATION_ID remains a fallback until a warehouse is saved there.
 * Optional overrides: KIT_TYPE_FIELD_ID, VIRTUAL_KIT_OPTION_ID.
 * The "woocommerce-poll" schedule polls GET /wp-json/wc/v3/orders?status=completed from the
 * cursor saved in fulfillment_settings.wc_poll_cursor, at most 250 pages per tick.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { backendPath, createHandler, err } from '@heysutton/sdk-server';

import { POLL_JOB_NAME } from './config.js';
import { handleFulfillment } from './routes.js';
import { createFulfillment } from './service.js';
import { handleSetup } from './setup.js';

export default createHandler({
  jobs: {
    // Platform schedule tick (every 1200s, see manifest.json) and the operator-triggered
    // "Run now" submit (POST /fulfillment/reconcile-now) both land here under the same name.
    [POLL_JOB_NAME]: ({ env, kind }) => createFulfillment(env).reconcileFromWooCommerce({ trigger: kind }),
  },
  fetch: async ({ request, env }) => {
    const path = backendPath(request);
    const { method } = request;

    const setupResponse = await handleSetup({ env, path, method });
    if (setupResponse) return setupResponse;

    const fulfillmentResponse = await handleFulfillment({ request, env, path, method });
    if (fulfillmentResponse) return fulfillmentResponse;

    return err({ code: AppErrorCode.NOT_FOUND, message: 'Not found.', status: 404 });
  },
});
