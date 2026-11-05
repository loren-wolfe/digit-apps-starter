import { AppErrorCode } from '@heysutton/sdk';
import { HandlerError, requireEnv } from '@heysutton/sdk-server';

import { appendActivity, pruneActivityLog } from './activity.js';
import {
  markPackageCatalogAttempt,
  packageCatalogConnectionsDue,
  syncConnectionPackageCatalog,
} from './packageCatalog.js';
import { credentialsForApi, liveCredentials, pollOutboundPush, pollPendingLabels } from './sync.js';

export async function pollSync({ env }) {
  const db = requireEnv({ env, key: 'SHIPSTATION_DB' });
  const outbound = await pollOutboundPush({ env, db, source: 'schedule' });
  const labels = await pollPendingLabels({ env, db });
  return { ...outbound, ...labels };
}

export async function pruneActivity({ env }) {
  const db = requireEnv({ env, key: 'SHIPSTATION_DB' });
  return pruneActivityLog({ db, now: new Date() });
}

export async function refreshPackageCatalog({ env }) {
  const db = requireEnv({ env, key: 'SHIPSTATION_DB' });
  const now = new Date();
  const { results } = await db
    .prepare(
      `SELECT c.id AS connection_id, c.organization_id, s.pulled_on, s.last_attempt_at
       FROM shipstation_connection c
       LEFT JOIN package_catalog_sync s ON s.connection_id = c.id
       WHERE c.deleted = 0
       ORDER BY c.id`,
    )
    .all();
  const { due, today, skipped } = packageCatalogConnectionsDue({ rows: results, now });
  if (skipped) return { skipped: true, refreshed: 0 };
  let refreshed = 0;
  for (const row of due) {
    try {
      const secret = await liveCredentials({ db, env, organizationId: row.organization_id });
      const credentials = credentialsForApi(secret);
      if (!credentials) {
        await markPackageCatalogAttempt({ db, connectionId: row.connection_id, pulledOn: null });
        await appendActivity({
          db,
          organizationId: row.organization_id,
          actor: 'schedule',
          action: 'catalog_pull',
          status: 'error',
          message: secret?.mismatch || 'Connect a ShipStation account before package types can refresh.',
        });
        continue;
      }
      await syncConnectionPackageCatalog({
        db,
        connectionId: row.connection_id,
        organizationId: row.organization_id,
        credentials,
        actor: 'schedule',
        pulledOn: today,
      });
      refreshed += 1;
    } catch (error) {
      await markPackageCatalogAttempt({ db, connectionId: row.connection_id, pulledOn: null }).catch(() => {});
      await appendActivity({
        db,
        organizationId: row.organization_id,
        actor: 'schedule',
        action: 'catalog_pull',
        status: 'error',
        message: error instanceof Error ? error.message : 'Could not refresh package types.',
      }).catch(() => {});
    }
  }
  return { skipped: false, refreshed };
}

export function jobsUnavailable(error) {
  return error instanceof HandlerError && error.code === AppErrorCode.MISSING_CONFIG;
}
