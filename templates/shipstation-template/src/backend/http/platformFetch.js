/**
 * Generic upstream HTTP client for commerce channel APIs.
 * Mirror ssFetch: never include secrets or raw upstream bodies in errors.
 */

import { AppErrorCode } from '@heysutton/sdk';

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} json
 * @param {number} httpStatus
 * @returns {string}
 */
function defaultFormatError(json, httpStatus) {
  if (json && typeof json === 'object') {
    const record = /** @type {Record<string, unknown>} */ (json);
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.title === 'string' && record.title) ||
      null;
    if (message) return message;
  }
  return `Upstream request failed (HTTP ${httpStatus}).`;
}

/**
 * @param {string | undefined} urlString
 * @param {Set<string> | undefined} allowedHosts
 */
export function allowedPlatformUrl(urlString, allowedHosts) {
  if (!urlString || !allowedHosts?.size) return true;
  try {
    const url = new URL(urlString);
    return url.protocol === 'https:' && allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * @param {object} args
 * @param {string} args.baseUrl
 * @param {string} [args.path]
 * @param {string} [args.method]
 * @param {Record<string, string>} [args.headers]
 * @param {unknown} [args.body]
 * @param {string} [args.url]
 * @param {(json: unknown, httpStatus: number) => string} [args.formatError]
 * @param {Set<string>} [args.allowedHosts]
 * @returns {Promise<
 *   | { ok: true, data: unknown }
 *   | { ok: false, code: string, message: string, status: number, detail?: unknown }
 * >}
 */
export async function platformFetch({
  baseUrl,
  path = '',
  method = 'GET',
  headers = {},
  body,
  url: absoluteUrl,
  formatError = defaultFormatError,
  allowedHosts,
}) {
  const target = absoluteUrl || `${baseUrl.replace(/\/$/, '')}${path}`;
  if (absoluteUrl && !allowedPlatformUrl(absoluteUrl, allowedHosts)) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'Refusing to fetch a disallowed upstream URL.',
      status: 400,
    };
  }

  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Could not reach the upstream service. Try again in a moment.',
      status: 502,
    };
  }

  const json = response.status === 204 ? null : await readJson(response);

  if (!response.ok) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: formatError(json, response.status),
      status: response.status >= 500 ? 502 : 400,
      detail: { httpStatus: response.status },
    };
  }

  if (response.status === 204) {
    return { ok: true, data: null };
  }

  return { ok: true, data: json };
}
