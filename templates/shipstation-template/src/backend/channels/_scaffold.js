/**
 * Copy this file to `channels/{platform}.js`, register in `registry.js`, and implement
 * the platform-specific API calls. Look up REST paths in
 * `.agents/skills/extend-shipstation-app/reference/channel-recipes.md`.
 *
 * @typedef {import('./types.js').ChannelAdapter} ChannelAdapter
 */

import { readChannelSecrets, shipstationDb } from '../runtimeConfig.js';

/** @type {ChannelAdapter} */
export const scaffoldAdapter = {
  id: 'example',
  label: 'Example store',
  secretKeys: ['EXAMPLE_API_TOKEN'],

  async isConfigured({ env }) {
    const db = shipstationDb({ env });
    const secrets = await readChannelSecrets({ env, db, channelId: 'example' });
    return secrets.every((entry) => entry.present);
  },

  async afterDigitShipped({ env, order, shipment }) {
    void env;
    void order;
    void shipment;
    return {
      status: 'skipped',
      skipped: true,
      reason: 'Implement afterDigitShipped in your channel adapter.',
    };
  },
};
