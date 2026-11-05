import { AppErrorCode } from '@heysutton/sdk';
import { err, ok, requireEnv } from '@heysutton/sdk-server';

import { channelStatusForOrg } from './channels/registry.js';

function requireOrganizationId(url) {
  const organizationId = (url.searchParams.get('organizationId') || '').trim();
  if (!organizationId) {
    return {
      error: err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'organizationId is required.',
        status: 400,
      }),
    };
  }
  return { organizationId };
}

export async function handleChannels({ request, env, path, method }) {
  if (path !== '/channels/status') return null;
  if (method !== 'GET') {
    return err({ code: AppErrorCode.NOT_FOUND, message: 'Not found.', status: 404 });
  }

  const db = requireEnv({ env, key: 'SHIPSTATION_DB' });
  const url = new URL(request.url);
  const org = requireOrganizationId(url);
  if (org.error) return org.error;

  const data = await channelStatusForOrg({ env, db, organizationId: org.organizationId });
  return ok({ data });
}
