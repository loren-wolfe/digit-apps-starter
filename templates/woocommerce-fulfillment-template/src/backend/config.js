import { optionalEnv } from '@heysutton/sdk-server';

export function parseLogSince(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function trimmedEnv(env, key) {
  return String(optionalEnv({ env, key }) || '').trim();
}

/** Job name shared by the manifest schedule and the Run now submit. */
export const POLL_JOB_NAME = 'woocommerce-poll';

/** Key stored on `fulfillment_syncs.warehouse_location` for the single configured warehouse. */
export const PRIMARY_LOCATION_KEY = 'PRIMARY';

export function fulfillmentConfig(env) {
  return {
    logSince: parseLogSince(optionalEnv({ env, key: 'FULFILLMENT_LOG_SINCE' })),
    // Fixed cap. 50 still finishes inside the 20-minute schedule when automated deductions
    // are on. Anything past the cap waits for the next tick.
    reconcileMaxPerRun: 50,
    // Fixed gap between each candidate's Sutton calls within one reconcile run.
    reconcilePacingMs: 200,
    externalOrderPlatform: 'WOO_COMMERCE',
    wcStoreUrl: trimmedEnv(env, 'WC_STORE_URL').replace(/\/+$/, ''),
    wcConsumerKey: trimmedEnv(env, 'WC_CONSUMER_KEY'),
    wcConsumerSecret: trimmedEnv(env, 'WC_CONSUMER_SECRET'),
    // Hard cap on WooCommerce pages one poll tick fetches. Past it, the saved cursor
    // resumes on the next tick.
    wcPollMaxPages: 250,
    // First-run window when no cursor is saved and FULFILLMENT_LOG_SINCE is unset.
    wcPollInitialLookbackHours: 48,
    // Fallback only. A warehouse saved on the Configuration tab wins over this secret.
    warehouseLocationId: trimmedEnv(env, 'WAREHOUSE_LOCATION_ID'),
    kitTypeFieldIdOverride: trimmedEnv(env, 'KIT_TYPE_FIELD_ID'),
    virtualKitOptionIdOverride: trimmedEnv(env, 'VIRTUAL_KIT_OPTION_ID'),
    nodeEnv: optionalEnv({ env, key: 'NODE_ENV' }) || '',
  };
}
