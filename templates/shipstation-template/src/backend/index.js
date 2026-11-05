/**
 * ShipStation template Worker.
 *
 * D1 binding: SHIPSTATION_DB
 * Config: JWT_TOKEN (staff-generated Clerk JWT) and ShipStation secrets are Digit App
 * Secrets (Worker `env` only). D1 `app_config` keeps ENCRYPTION_KEY for legacy decrypt.
 * Optional channel secrets: FAIRE_API_KEY, SHOPIFY_*, WOOCOMMERCE_* (see runtimeConfig.CHANNEL_SECRETS)
 * Digit GraphQL URL is always https://api.digit-software.com/graphql.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { backendPath, createHandler, err } from '@heysutton/sdk-server';

import { handleChannels } from './handleChannels.js';
import { handleConnection } from './connection.js';
import { handleSetup } from './setup.js';
import { handleSync } from './handleSync.js';
import { pollSync, pruneActivity, refreshPackageCatalog } from './jobs.js';

export default createHandler({
  jobs: {
    'poll-outbound-push': pollSync,
    'prune-activity': pruneActivity,
    'refresh-package-catalog': refreshPackageCatalog,
  },
  fetch: async ({ request, env }) => {
    const path = backendPath(request);
    const { method } = request;

    const setupResponse = await handleSetup({ env, path, method });
    if (setupResponse) return setupResponse;

    const channelsResponse = await handleChannels({ request, env, path, method });
    if (channelsResponse) return channelsResponse;

    const syncResponse = await handleSync({ request, env, path, method });
    if (syncResponse) return syncResponse;

    const connectionResponse = await handleConnection({ request, env, path, method });
    if (connectionResponse) return connectionResponse;

    return err({ code: AppErrorCode.NOT_FOUND, message: 'Not found.', status: 404 });
  },
});
