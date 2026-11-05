import { fulfillmentConfig } from './config.js';

// WooCommerce REST caps `per_page` at 100.
export const WC_PAGE_SIZE = 100;
const MAX_RETRIES = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response, attempt) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 8000);
  return Math.min(500 * 2 ** attempt, 8000);
}

export function isWooCommerceConfigured(env) {
  const cfg = fulfillmentConfig(env);
  return Boolean(cfg.wcStoreUrl && cfg.wcConsumerKey && cfg.wcConsumerSecret);
}

// A 404 on a page path (for example /shop) is remembered so later pages skip that miss.
const originFallback = new Map();

/** Site base for `/wp-json/wc/v3/orders`. Drops a pasted REST prefix; keeps a real subdirectory. */
export function storeBase(raw) {
  const url = new URL(raw);
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/index\.php$/i, '');
  path = path.replace(/\/wp-json(?:\/wc\/v\d(?:\/orders)?)?$/i, '');
  return `${url.origin}${path}`;
}

async function fetchOrders(url, authorization) {
  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
      });
    } catch {
      throw wcError('Could not reach the WooCommerce store at WC_STORE_URL.');
    }
    if (response.status !== 429 || attempt >= MAX_RETRIES) return response;
    await sleep(retryAfterMs(response, attempt));
  }
}

async function wooErrorDetail(response) {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : null;
  } catch {
    return null;
  }
}

function wcError(message, code = 'WC_API', detail = null) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/**
 * One page of completed WooCommerce orders, oldest-modified first.
 * `GET /wp-json/wc/v3/orders?status=completed`. `modifiedAfter` is an ISO GMT timestamp.
 * @returns {Promise<{ orders: object[], totalPages: number | null, total: number | null }>}
 */
export async function listCompletedOrdersPage(env, { modifiedAfter, page = 1 } = {}) {
  if (!isWooCommerceConfigured(env)) {
    throw wcError(
      'WooCommerce REST is not configured (WC_STORE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET).',
      'CONFIG_MISSING',
    );
  }

  const cfg = fulfillmentConfig(env);
  let base;
  try {
    base = originFallback.get(cfg.wcStoreUrl) || storeBase(cfg.wcStoreUrl);
  } catch {
    throw wcError('WC_STORE_URL is not a valid URL. Example: https://shop.example.com', 'CONFIG_MISSING');
  }

  const authorization = `Basic ${btoa(`${cfg.wcConsumerKey}:${cfg.wcConsumerSecret}`)}`;
  const ordersUrl = (root) => {
    const url = new URL(`${root}/wp-json/wc/v3/orders`);
    url.searchParams.set('status', 'completed');
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(WC_PAGE_SIZE));
    url.searchParams.set('orderby', 'modified');
    url.searchParams.set('order', 'asc');
    url.searchParams.set('dates_are_gmt', 'true');
    if (modifiedAfter) url.searchParams.set('modified_after', modifiedAfter);
    return url;
  };

  let url = ordersUrl(base);
  let response = await fetchOrders(url, authorization);
  // A pasted shop page path is not the API. The REST route is on the origin.
  if (response.status === 404) {
    const origin = new URL(base).origin;
    if (`${origin}` !== base.replace(/\/+$/, '')) {
      const retry = await fetchOrders(ordersUrl(origin), authorization);
      if (retry.ok || retry.status === 401 || retry.status === 403) {
        originFallback.set(cfg.wcStoreUrl, origin);
        url = ordersUrl(origin);
        response = retry;
      }
    }
  }

  if (response.status === 401 || response.status === 403) {
    // WooCommerce only accepts key/secret basic auth over HTTPS, and a redirect to another
    // origin drops the Authorization header, so both look like a bad key from here.
    let message = 'WooCommerce rejected WC_CONSUMER_KEY / WC_CONSUMER_SECRET. Check the REST key has Read access.';
    if (url.protocol === 'http:') {
      message = 'WooCommerce rejected the request because WC_STORE_URL uses http://. Change it to https:// and try again.';
    } else if (response.redirected) {
      const finalOrigin = new URL(response.url).origin;
      if (finalOrigin !== url.origin) {
        message = `WooCommerce rejected the request after WC_STORE_URL redirected to ${finalOrigin}. Set WC_STORE_URL to ${finalOrigin} and try again.`;
      }
    }
    throw wcError(message, 'CONFIG_MISSING', { httpStatus: response.status });
  }
  if (!response.ok) {
    const detail = response.status === 429 ? null : await wooErrorDetail(response);
    const target = `${url.origin}${url.pathname}`;
    throw wcError(
      response.status === 429
        ? `WooCommerce API rate limit reached (still 429 after ${MAX_RETRIES} retries).`
        : response.status === 404
          ? `WooCommerce API HTTP 404 at ${target}. Set WC_STORE_URL to the site origin (${url.origin}), not a page path.`
          : detail
            ? `WooCommerce API HTTP ${response.status}: ${detail}`
            : `WooCommerce API HTTP ${response.status}`,
      'WC_API',
      { httpStatus: response.status },
    );
  }

  let orders;
  try {
    orders = await response.json();
  } catch {
    throw wcError('WooCommerce API returned a non-JSON body.');
  }
  if (!Array.isArray(orders)) throw wcError('WooCommerce API returned an unexpected order list.');

  const headerNumber = (name) => {
    const raw = response.headers.get(name);
    const value = raw == null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return { orders, totalPages: headerNumber('x-wp-totalpages'), total: headerNumber('x-wp-total') };
}
