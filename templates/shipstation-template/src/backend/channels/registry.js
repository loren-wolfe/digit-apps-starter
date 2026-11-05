/**
 * Channel adapter registry. Outbound hooks run after Digit shipment writeback.
 */

import { appendActivity } from '../activity.js';
import { readChannelSecrets, shipstationDb } from '../runtimeConfig.js';
import { faireAdapter } from './faire.js';
import { listChannelConnections } from './store.js';
import { shopifyAdapter } from './shopify.js';
import { woocommerceAdapter } from './woocommerce.js';

/** @type {import('./types.js').ChannelAdapter[]} */
const ADAPTERS = [faireAdapter, shopifyAdapter, woocommerceAdapter];

export function listAdapters() {
  return ADAPTERS;
}

/** @param {string} channelId */
export function getAdapter(channelId) {
  return ADAPTERS.find((adapter) => adapter.id === channelId) ?? null;
}

function resultStatus(result) {
  if (result.status) return result.status;
  if (result.skipped) return 'skipped';
  return 'success';
}

/**
 * Run all configured outbound channel adapters after Digit shipment writeback.
 * @param {import('./types.js').AfterDigitShippedContext} ctx
 */
export async function runAfterDigitShipped({ env, order, shipment, organizationId = null }) {
  const db = shipstationDb({ env });
  const results = [];

  for (const adapter of ADAPTERS) {
    if (!adapter.afterDigitShipped) continue;

    let configured = false;
    try {
      configured = await adapter.isConfigured({ env, db });
    } catch {
      configured = false;
    }
    if (!configured) continue;

    let result;
    try {
      result = await adapter.afterDigitShipped({
        env,
        db,
        organizationId,
        order,
        shipment,
      });
    } catch (error) {
      result = {
        status: 'error',
        message: error instanceof Error ? error.message : 'Channel adapter failed.',
      };
    }

    const status = resultStatus(result);
    results.push({ channelId: adapter.id, status, ...result });

    if (organizationId && db && status === 'error') {
      await appendActivity({
        db,
        organizationId,
        actor: 'channel',
        action: 'channel.fulfillment',
        status: 'error',
        message: result.message || `${adapter.label} fulfillment failed.`,
        digitOrderId: typeof order?.id === 'string' ? order.id : null,
        channelId: adapter.id,
        externalOrderId: result.externalOrderId ?? null,
      });
    }

    if (organizationId && db && status === 'success') {
      await appendActivity({
        db,
        organizationId,
        actor: 'channel',
        action: 'channel.fulfillment',
        status: 'success',
        message: result.message || `${adapter.label} fulfillment updated.`,
        digitOrderId: typeof order?.id === 'string' ? order.id : null,
        channelId: adapter.id,
        externalOrderId: result.externalOrderId ?? null,
      });
    }
  }

  return results;
}

/** @deprecated Prefer runAfterDigitShipped. */
export async function afterDigitShipped(ctx) {
  return runAfterDigitShipped(ctx);
}

export async function channelSetupEntries({ env, db }) {
  const entries = [];
  for (const adapter of ADAPTERS) {
    const secrets = await readChannelSecrets({ env, db, channelId: adapter.id });
    let configured = false;
    try {
      configured = await adapter.isConfigured({ env, db });
    } catch {
      configured = false;
    }
    entries.push({
      id: adapter.id,
      label: adapter.label,
      configured,
      secrets,
    });
  }
  return entries;
}

export async function channelStatusForOrg({ env, db, organizationId }) {
  const entries = await channelSetupEntries({ env, db });
  const connections = organizationId
    ? await listChannelConnections({ db, organizationId })
    : [];
  return {
    channels: entries.map((entry) => ({
      ...entry,
      connections: connections.filter((row) => row.channelId === entry.id),
    })),
  };
}
