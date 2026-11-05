/**
 * Optional Faire shipment writeback. Off unless FAIRE_API_KEY is set.
 * Look up the current Faire order-shipment endpoint before filling this in.
 *
 * @typedef {import('./types.js').ChannelAdapter} ChannelAdapter
 */

import { readChannelSecrets, shipstationDb } from '../runtimeConfig.js';

/** @type {ChannelAdapter} */
export const faireAdapter = {
  id: 'faire',
  label: 'Faire',
  secretKeys: ['FAIRE_API_KEY'],

  async isConfigured({ env }) {
    const db = shipstationDb({ env });
    const secrets = await readChannelSecrets({ env, db, channelId: 'faire' });
    return secrets.every((entry) => entry.present);
  },

  async afterDigitShipped({ env, order, shipment }) {
    const db = shipstationDb({ env });
    const configured = await faireAdapter.isConfigured({ env, db });
    if (!configured) {
      return { status: 'skipped', skipped: true };
    }
    void order;
    void shipment;
    return {
      status: 'skipped',
      skipped: true,
      reason: 'Faire client is a recipe — implement in a clone.',
    };
  },
};

/** @deprecated Use faireAdapter.afterDigitShipped via registry. */
export async function notifyFaire({ env, order, shipment }) {
  return faireAdapter.afterDigitShipped({ env, db: shipstationDb({ env }), order, shipment });
}
