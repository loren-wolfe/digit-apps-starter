/**
 * Sutton → Shopify item publisher.
 *
 * Secrets: API_TOKEN_SUTTON (READ_ITEM, READ_ITEM_COST_INFO, and UPDATE_ITEM), and for each
 * store a shop subdomain, client ID, and client secret. The Worker exchanges
 * the Shopify credentials for an access token.
 * There is no schedule and no database. Every publish is started from the page.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { backendPath, createHandler, err } from '@heysutton/sdk-server';

import { handlePublish } from './routes.js';
import { handleSetup } from './setup.js';

export default createHandler({
  fetch: async ({ request, env }) => {
    const path = backendPath(request);
    const { method } = request;

    const setupResponse = await handleSetup({ env, path, method });
    if (setupResponse) return setupResponse;

    const publishResponse = await handlePublish({ request, env, path, method });
    if (publishResponse) return publishResponse;

    return err({ code: AppErrorCode.NOT_FOUND, message: 'Not found.', status: 404 });
  },
});
