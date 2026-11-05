/**
 * First-load config, read-only.
 *
 * Setup secrets are Digit App Secrets injected as `env.KEY`. This route reports what the
 * Worker can actually see, so the UI can say which features work.
 * SHIPSTATION_DB is a publish binding — never shown in the UI.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { err, ok } from '@heysutton/sdk-server';

import {
  readJwtToken,
  readShipStationApiKey,
  readShipStationApiSecret,
  resolveShipStationCredentials,
  shipstationDb,
} from './runtimeConfig.js';
import { channelSetupEntries } from './channels/registry.js';

async function setupItems({ env, db }) {
  const token = await readJwtToken({ env, db });
  const shipStationKey = await readShipStationApiKey({ env, db });
  const shipStationSecret = await readShipStationApiSecret({ env, db });

  /** Required first so Setup "N of M" matches checklist numbering. */
  const required = [
    {
      key: 'SHIPSTATION_API_KEY',
      kind: 'secret',
      required: true,
      present: Boolean(shipStationKey.value),
      valid: Boolean(shipStationKey.value),
      source: shipStationKey.source,
      issue: shipStationKey.value ? null : 'Add a ShipStation API key (V2 alone, or V1 key with secret).',
      enables: 'Everything that talks to ShipStation: carrier sync, pushes, and label polling.',
      description:
        'ShipStation API key for this organization. Alone = V2 (api.shipstation.com). With SHIPSTATION_API_SECRET = V1 Basic auth (ssapi.shipstation.com). Validated when you connect.',
    },
    {
      key: 'JWT_TOKEN',
      kind: 'secret',
      required: true,
      present: Boolean(token.value),
      valid: Boolean(token.value),
      source: token.source,
      issue: token.value ? null : 'Ask Sutton staff to generate JWT_TOKEN and place it on this account.',
      enables: 'Pushing shipments to ShipStation, tracking writeback, and the scheduled poll.',
      description:
        'Clerk JWT used by the Worker for Sutton GraphQL (poll writeback and scheduled push). Sutton staff generate this token and place it in the organization’s app secrets. Do not create a da_ API token — those cannot update shipments. Saved as a Sutton app secret, so its value is write-only.',
    },
  ];

  const secretItem = {
    key: 'SHIPSTATION_API_SECRET',
    kind: 'secret',
    required: false,
    present: Boolean(shipStationSecret.value),
    valid: true,
    source: shipStationSecret.source,
    issue: null,
    enables: 'V1 API mode (ssapi.shipstation.com with Basic auth). Omit for V2.',
    description:
      'Optional. When set with SHIPSTATION_API_KEY, connect uses ShipStation V1. Disconnect and reconnect after adding or removing this secret.',
  };

  return [...required, secretItem];
}

function setupPayload({ db, items, channels, apiMode }) {
  const present = (key) => Boolean(items.find((item) => item.key === key)?.present);
  const ready =
    Boolean(db) && items.filter((item) => item.required).every((item) => item.present && item.valid);
  const anyChannelConfigured = channels.some((channel) => channel.configured);
  return {
    ready,
    usable: Boolean(db),
    apiTokenPresent: present('JWT_TOKEN'),
    shipStationKeyPresent: present('SHIPSTATION_API_KEY'),
    shipStationSecretPresent: present('SHIPSTATION_API_SECRET'),
    shipStationApiMode: apiMode,
    anyChannelConfigured,
    items,
    channels,
  };
}

/**
 * @returns {Promise<Response | null>}
 */
export async function handleSetup({ env, path, method }) {
  if (path !== '/setup') return null;

  const db = shipstationDb({ env });

  if (method === 'GET') {
    const channels = await channelSetupEntries({ env, db });
    const credentials = db ? await resolveShipStationCredentials({ env, db }) : null;
    const apiMode = credentials?.apiVersion ?? 'missing';
    return ok({
      data: setupPayload({
        db,
        items: await setupItems({ env, db }),
        channels,
        apiMode,
      }),
    });
  }

  if (method === 'POST') {
    return err({
      code: AppErrorCode.VALIDATION_ERROR,
      message:
        'Setup values are Sutton app secrets. Manage them in Sutton → Apps → this app → Secrets.',
      status: 400,
    });
  }

  return null;
}
