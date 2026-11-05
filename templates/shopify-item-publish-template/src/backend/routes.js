import { AppErrorCode } from '@heysutton/sdk';
import { err, ok } from '@heysutton/sdk-server';

import { PAGE_SIZE } from './mapping.js';
import { previewItem, publishItem } from './publish.js';
import { searchItems } from './sutton.js';

function mapError(error) {
  if (error?.name === 'HandlerError' && error.code) {
    return err({ code: error.code, message: error.message, status: error.status || 400 });
  }
  const code = error?.code || AppErrorCode.SERVER_ERROR;
  if (code === 'SUTTON_API' || code === 'SHOPIFY_API' || code === 'SHOPIFY_AUTH') {
    return err({
      code: AppErrorCode.UPSTREAM_ERROR,
      message: error.message || 'Upstream request failed.',
      status: 502,
    });
  }
  if (code === AppErrorCode.MISSING_CONFIG) {
    return err({ code, message: error.message, status: 400 });
  }
  return err({
    code: AppErrorCode.SERVER_ERROR,
    message: error?.message || 'Something went wrong.',
    status: 500,
  });
}

export async function handlePublish({ request, env, path, method }) {
  try {
    if (method === 'GET' && path === '/items') {
      const url = new URL(request.url);
      const data = await searchItems({ env, search: url.searchParams.get('search') || '' });
      return ok({ data: { ...data, pageSize: PAGE_SIZE } });
    }

    if (method === 'POST' && path === '/publish') {
      const body = await request.json().catch(() => null);
      const publishItemId = typeof body?.itemId === 'string' ? body.itemId.trim() : '';
      if (!publishItemId) {
        return err({ code: AppErrorCode.VALIDATION_ERROR, message: 'Choose a Sutton item.', status: 400 });
      }
      const published = await publishItem({
        env,
        itemId: publishItemId,
        mapping: body?.mapping,
        storeIds: body?.stores,
        targets: body?.targets && typeof body.targets === 'object' ? body.targets : {},
        idStore: typeof body?.idStore === 'string' ? body.idStore : '',
        variantIds: body?.variantIds,
      });
      if (!published) return err({ code: AppErrorCode.NOT_FOUND, message: 'Sutton item not found.', status: 404 });
      return ok({ data: published });
    }

    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'items' || !parts[1]) return null;
    const itemId = decodeURIComponent(parts[1]);

    if (method === 'GET' && parts.length === 3 && parts[2] === 'preview') {
      const url = new URL(request.url);
      let mapping = null;
      const rawMapping = url.searchParams.get('mapping');
      if (rawMapping) {
        try {
          mapping = JSON.parse(rawMapping);
        } catch {
          return err({ code: AppErrorCode.VALIDATION_ERROR, message: 'Field mapping could not be read.', status: 400 });
        }
      }
      const preview = await previewItem({
        env,
        itemId,
        mapping,
        variantIds: url.searchParams.has('variants') ? url.searchParams.get('variants') : undefined,
      });
      if (!preview) return err({ code: AppErrorCode.NOT_FOUND, message: 'Sutton item not found.', status: 404 });
      return ok({ data: preview });
    }

    return null;
  } catch (error) {
    return mapError(error);
  }
}
