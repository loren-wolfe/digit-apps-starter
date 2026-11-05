/**
 * Read-only setup status. Secrets are Sutton app secrets injected as env.
 * This route reports presence only and never returns secret values.
 * Store readiness includes the client-credentials token exchange.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { err, ok } from '@heysutton/sdk-server';

import { shopDomain } from './mapping.js';
import { probeStore, readStores, STORE_SPECS } from './shopify.js';

const SECRET_MESSAGE =
  'Setup values are Sutton app secrets. Go to Settings in Sutton Studio and add to Secrets. Only the app’s original Studio admin can save secret values.';

const SECRET_COPY = {
  API_TOKEN_SUTTON: {
    enables: 'Searching Sutton items and reading the default sales price that gets published.',
    description:
      'API token the Worker uses to read Sutton and write Shopify ids back onto items. Grant Read items (READ_ITEM), Read item cost info (READ_ITEM_COST_INFO), and Update items (UPDATE_ITEM).',
  },
  SHOPIFY_STORE_A_SHOP: {
    enables: 'Calling the retail Shopify store.',
    description:
      'Shop subdomain for Store A, such as my-retail-store. The Dev Dashboard app that owns the client ID must be in the same Shopify organization as this store.',
  },
  SHOPIFY_STORE_A_CLIENT_ID: {
    enables: 'Exchanging Store A credentials for an access token.',
    description:
      'Client ID from the Dev Dashboard app installed on Store A. Dev Dashboard → Apps → your app → Settings → Credentials.',
  },
  SHOPIFY_STORE_A_CLIENT_SECRET: {
    enables: 'Exchanging Store A credentials for an access token.',
    description:
      'Client secret from the same Dev Dashboard app. The Worker exchanges the client ID and secret for a 24-hour access token. Do not paste an Admin API access token.',
  },
  SHOPIFY_STORE_B_SHOP: {
    enables: 'Calling the B2B Shopify store.',
    description:
      'Shop subdomain for Store B, such as my-b2b-store. Same Shopify organization rule as Store A. The two stores can use different Dev Dashboard apps.',
  },
  SHOPIFY_STORE_B_CLIENT_ID: {
    enables: 'Exchanging Store B credentials for an access token.',
    description: 'Client ID from the Dev Dashboard app installed on Store B. Settings → Credentials.',
  },
  SHOPIFY_STORE_B_CLIENT_SECRET: {
    enables: 'Exchanging Store B credentials for an access token.',
    description:
      'Client secret from the Store B Dev Dashboard app. Scopes on the app version must include write_products and read_products, and the app must be installed on the store.',
  },
};

function readSecret(env, key) {
  const raw = env?.[key];
  const present = typeof raw === 'string' && raw.trim().length > 0;
  return { present, valid: present, source: present ? 'appSecret' : null };
}

function setupItems(env) {
  return Object.keys(SECRET_COPY).map((key) => {
    const secret = readSecret(env, key);
    return {
      key,
      kind: 'secret',
      required: true,
      present: secret.present,
      valid: secret.valid,
      source: secret.source,
      issue: null,
      enables: SECRET_COPY[key].enables,
      description: SECRET_COPY[key].description,
      profiles: [],
    };
  });
}

export async function setupPayload(env) {
  const items = setupItems(env);
  const secretsReady = items.every((item) => item.present && item.valid);
  const stores = [];
  for (const store of readStores(env)) {
    const probe = store.configured ? await probeStore(store) : { ready: false, error: null, name: null };
    stores.push({
      id: store.id,
      label: store.label,
      shop: store.shop,
      domain: shopDomain(store.shop),
      configured: store.configured,
      ready: probe.ready,
      error: store.configured ? probe.error : null,
      name: probe.name,
    });
  }
  return {
    ready: secretsReady,
    usable: true,
    items,
    stores,
    storeSecretKeys: STORE_SPECS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      shopKey: spec.shopKey,
      clientIdKey: spec.idKey,
      clientSecretKey: spec.secretKey,
    })),
  };
}

export async function handleSetup({ env, path, method }) {
  if (path !== '/setup') return null;
  if (method === 'GET') return ok({ data: await setupPayload(env) });
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    return err({ code: AppErrorCode.VALIDATION_ERROR, message: SECRET_MESSAGE, status: 400 });
  }
  return null;
}
