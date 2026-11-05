/**
 * Read-only setup status. Secrets are Sutton app secrets injected as env.
 * This route reports presence only and never returns secret values.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { err, ok } from '@heysutton/sdk-server';

const SECRET_MESSAGE =
  'Setup values are not collected here. Add secrets under Secrets, and environment variables under Environment variables, in Settings in Sutton Studio.';

function isPresent(env, key) {
  const raw = env?.[key];
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * One catalog entry per key. `kind: 'env'` marks plain configuration (an id or a tuning
 * number) rather than a credential. The fulfillment warehouse is chosen on the
 * Configuration tab and stored in the app database.
 */
const CATALOG = [
  {
    key: 'API_TOKEN_SUTTON',
    kind: 'secret',
    required: true,
    enables: 'Matching sales orders, inventory deductions, and marking orders fulfilled.',
    description: 'Bearer token the worker uses for Sutton GraphQL. Example: an organization API token.',
    note: 'This token will be provided by a Sutton employee.',
    // From the `Permissions: requires …` notes on each root field and field the worker calls.
    permissions: [
      { key: 'READ_ORDER', label: 'Read Order', use: 'Find the Sutton order for each WooCommerce order and list open orders.' },
      {
        key: 'READ_INTEGRATION',
        label: 'Read Integration',
        use: 'Find the WooCommerce Rutter connection whose open orders are listed.',
      },
      { key: 'READ_ITEM', label: 'Read Item', use: 'Resolve order lines, alias items, and Virtual Kits.' },
      { key: 'READ_BOM', label: 'Read Bom', use: 'Expand Virtual Kits into their components.' },
      { key: 'READ_CUSTOM_FIELD', label: 'Read Custom Field', use: 'Find the Kit Type item field.' },
      { key: 'READ_INVENTORY', label: 'Read Inventory', use: 'Check stock in the default bin before deducting.' },
      { key: 'READ_WAREHOUSE_LOCATION', label: 'Read Warehouse Location', use: 'Confirm the default bin still exists.' },
      {
        key: 'READ_ORGANIZATION_DYNAMIC_FIELD',
        label: 'Read Organization Dynamic Field',
        use: 'Find the WooCommerce Fulfillment adjustment reasons.',
      },
      { key: 'UPDATE_INVENTORY', label: 'Update Inventory', use: 'Deduct stock, and add it back on Un-deduct.' },
      { key: 'UPDATE_ORDER', label: 'Update Order', use: 'Mark the Sutton order fulfilled.' },
      {
        key: 'CREATE_ORGANIZATION_DYNAMIC_FIELD',
        label: 'Create Organization Dynamic Field',
        use: 'Create the two adjustment reasons on first use. Update Organization Dynamic Field also works.',
      },
    ],
  },
  {
    key: 'WC_STORE_URL',
    kind: 'env',
    required: true,
    enables: 'Polling completed WooCommerce orders every 20 minutes.',
    description: 'WooCommerce store origin, without /wp-json. Example: https://shop.example.com',
  },
  {
    key: 'WC_CONSUMER_KEY',
    kind: 'secret',
    required: true,
    enables: 'Polling completed WooCommerce orders every 20 minutes.',
    description:
      'WooCommerce REST API consumer key with Read access (WooCommerce → Settings → Advanced → REST API). Starts with ck_.',
    note: 'Comes from WooCommerce. The key only needs Read permission.',
  },
  {
    key: 'WC_CONSUMER_SECRET',
    kind: 'secret',
    required: true,
    enables: 'Polling completed WooCommerce orders every 20 minutes.',
    description: 'The consumer secret paired with WC_CONSUMER_KEY. Starts with cs_.',
    note: 'Comes from WooCommerce with the consumer key. The key only needs Read permission.',
  },
  {
    key: 'FULFILLMENT_LOG_SINCE',
    kind: 'env',
    required: false,
    enables: 'Choosing the date the WooCommerce poll and the fulfillment log start from.',
    description:
      'ISO date. The poll reads completed orders from it, and the log hides orders received before it. Changing it makes the next poll re-read from the new date. Unset uses the date of the first poll (48 hours before it ran). Example: 2026-08-12.',
  },
];

function setupItems(env) {
  return CATALOG.map((entry) => {
    const present = isPresent(env, entry.key);
    return {
      ...entry,
      present,
      valid: present,
      source: present ? 'appSecret' : null,
      issue: null,
      profiles: [],
    };
  });
}

function runtimeStoreExists(env) {
  const db = env?.WOOCOMMERCE_FULFILLMENT_DB;
  return db != null && db !== '';
}

/**
 * @returns {Promise<Response | null>}
 */
export async function handleSetup({ env, path, method }) {
  if (path !== '/setup') return null;

  if (method === 'GET') {
    const usable = runtimeStoreExists(env);
    const items = await setupItems(env);
    const ready =
      usable && items.filter((item) => item.required).every((item) => item.present && item.valid);
    return ok({
      data: {
        ready,
        usable,
        items,
      },
    });
  }

  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    return err({
      code: AppErrorCode.VALIDATION_ERROR,
      message: SECRET_MESSAGE,
      status: 400,
    });
  }

  return null;
}
