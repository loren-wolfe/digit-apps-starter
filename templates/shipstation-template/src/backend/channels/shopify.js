/**
 * Optional Shopify adapter stub. Enable by setting SHOPIFY_ACCESS_TOKEN and
 * implementing fulfillment POST. See reference/channel-recipes.md.
 *
 * @typedef {import('./types.js').ChannelAdapter} ChannelAdapter
 */

import { readChannelSecrets, shipstationDb } from '../runtimeConfig.js';

/** @type {ChannelAdapter} */
export const shopifyAdapter = {
  id: 'shopify',
  label: 'Shopify',
  secretKeys: ['SHOPIFY_ACCESS_TOKEN'],

  async isConfigured({ env }) {
    const db = shipstationDb({ env });
    const secrets = await readChannelSecrets({ env, db, channelId: 'shopify' });
    return secrets.every((entry) => entry.present);
  },

  async afterDigitShipped({ env, order, shipment }) {
    void env;
    void order;
    void shipment;
    return {
      status: 'skipped',
      skipped: true,
      reason: 'Shopify fulfillment push is a recipe — implement in a clone or use Sutton Rutter.',
    };
  },
};
