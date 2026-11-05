/**
 * Optional WooCommerce adapter stub. Enable by setting consumer key/secret and
 * implementing fulfillment POST. See reference/channel-recipes.md.
 *
 * @typedef {import('./types.js').ChannelAdapter} ChannelAdapter
 */

import { readChannelSecrets, shipstationDb } from '../runtimeConfig.js';

/** @type {ChannelAdapter} */
export const woocommerceAdapter = {
  id: 'woocommerce',
  label: 'WooCommerce',
  secretKeys: ['WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET'],

  async isConfigured({ env }) {
    const db = shipstationDb({ env });
    const secrets = await readChannelSecrets({ env, db, channelId: 'woocommerce' });
    return secrets.every((entry) => entry.present);
  },

  async afterDigitShipped({ env, order, shipment }) {
    void env;
    void order;
    void shipment;
    return {
      status: 'skipped',
      skipped: true,
      reason: 'WooCommerce fulfillment push is a recipe — implement in a clone or use Sutton Rutter.',
    };
  },
};
