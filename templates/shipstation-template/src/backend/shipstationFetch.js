/**
 * Shared ShipStation HTTP helpers (V1 + V2). Never put the API key/secret or raw
 * upstream bodies into error messages or success payloads.
 */

import { AppErrorCode } from '@heysutton/sdk';

export const V2_BASE = 'https://api.shipstation.com';
export const V1_BASE = 'https://ssapi.shipstation.com';

export const INVALID_KEY_MESSAGE_V2 =
  'This API key was rejected by ShipStation. Create a V2 key in ShipStation → Settings → API, then try again.';

export const INVALID_KEY_MESSAGE_V1 =
  'These API credentials were rejected by ShipStation. Check SHIPSTATION_API_KEY and SHIPSTATION_API_SECRET (V1 Basic auth), then try again.';

export const ALLOWED_RESOURCE_HOSTS = new Set([
  'api.shipstation.com',
  'api.shipengine.com',
  'ssapi.shipstation.com',
]);

export function allowedShipStationUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'https:' && ALLOWED_RESOURCE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * ShipStation V2 / ShipEngine error body: `{ request_id, errors: [{ error_code, message, field_name }] }`.
 */
export function formatShipStationErrorV2(json, httpStatus) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const parts = errors
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const code = typeof entry.error_code === 'string' && entry.error_code ? `[${entry.error_code}] ` : '';
      const message = typeof entry.message === 'string' ? entry.message : '';
      const field =
        typeof entry.field_name === 'string' && entry.field_name ? ` (${entry.field_name})` : '';
      return `${code}${message}${field}`.trim();
    })
    .filter(Boolean);
  const requestId = typeof json?.request_id === 'string' && json.request_id ? json.request_id : null;
  const base = parts.length
    ? parts.join('; ')
    : `ShipStation request failed (HTTP ${httpStatus}).`;
  return requestId ? `${base} Request ${requestId}.` : base;
}

export function shipStationErrorDetailV2(json, httpStatus) {
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  return {
    httpStatus,
    requestId: typeof json?.request_id === 'string' ? json.request_id : null,
    errorCodes: errors
      .map((entry) => (typeof entry?.error_code === 'string' ? entry.error_code : null))
      .filter(Boolean),
  };
}

/** V1 bodies are often `{ Message }` or `{ message }`. */
export function formatShipStationErrorV1(json, httpStatus) {
  const message =
    (typeof json?.Message === 'string' && json.Message) ||
    (typeof json?.message === 'string' && json.message) ||
    (typeof json?.ExceptionMessage === 'string' && json.ExceptionMessage) ||
    null;
  return message || `ShipStation request failed (HTTP ${httpStatus}).`;
}

export function shipStationErrorDetailV1(json, httpStatus) {
  return {
    httpStatus,
    requestId: null,
    errorCodes: [],
    message:
      (typeof json?.Message === 'string' && json.Message) ||
      (typeof json?.message === 'string' && json.message) ||
      null,
  };
}

function v2Headers({ apiKey }) {
  return {
    'api-key': apiKey,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function v1Headers({ apiKey, apiSecret }) {
  const token = btoa(`${apiKey}:${apiSecret}`);
  return {
    Authorization: `Basic ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

export function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function requestHeaders({ credentials, accept }) {
  const isV1 = credentials.apiVersion === 'v1';
  const headers = isV1
    ? v1Headers({ apiKey: credentials.apiKey, apiSecret: credentials.apiSecret || '' })
    : v2Headers({ apiKey: credentials.apiKey });
  if (accept) headers.Accept = accept;
  return headers;
}

function resolveTarget({ credentials, path, absoluteUrl }) {
  const isV1 = credentials.apiVersion === 'v1';
  const base = isV1 ? V1_BASE : V2_BASE;
  return absoluteUrl || `${base}${path}`;
}

/**
 * @param {{
 *   credentials: { apiVersion: 'v1' | 'v2', apiKey: string, apiSecret?: string },
 *   method: string,
 *   path: string,
 *   body?: unknown,
 *   url?: string,
 *   timeoutMs?: number,
 * }} args
 */
export async function ssFetch({ credentials, method, path, body, url: absoluteUrl, timeoutMs }) {
  const isV1 = credentials.apiVersion === 'v1';
  const target = resolveTarget({ credentials, path, absoluteUrl });

  if (absoluteUrl && !allowedShipStationUrl(absoluteUrl)) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'Refusing to fetch a non-ShipStation URL.',
      status: 400,
    };
  }

  const headers = requestHeaders({ credentials });

  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: timedOut
        ? 'ShipStation did not respond in time. Try again in a moment.'
        : 'Could not reach ShipStation. Try again in a moment.',
      status: 502,
    };
  }

  const json = response.status === 204 ? null : await readJson(response);

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: isV1 ? INVALID_KEY_MESSAGE_V1 : INVALID_KEY_MESSAGE_V2,
      status: 400,
      detail: isV1
        ? shipStationErrorDetailV1(json, response.status)
        : shipStationErrorDetailV2(json, response.status),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: isV1
        ? formatShipStationErrorV1(json, response.status)
        : formatShipStationErrorV2(json, response.status),
      status: 502,
      detail: isV1
        ? shipStationErrorDetailV1(json, response.status)
        : shipStationErrorDetailV2(json, response.status),
    };
  }

  if (response.status === 204) {
    return { ok: true, data: null };
  }

  return { ok: true, data: json };
}

/**
 * Fetch a label PDF (or other binary) from an allowlisted ShipStation URL.
 *
 * @param {{
 *   credentials: { apiVersion: 'v1' | 'v2', apiKey: string, apiSecret?: string },
 *   method?: string,
 *   path?: string,
 *   url?: string,
 * }} args
 */
export async function ssFetchBytes({ credentials, method = 'GET', path = '/', url: absoluteUrl }) {
  const isV1 = credentials.apiVersion === 'v1';
  const target = resolveTarget({ credentials, path, absoluteUrl });

  if (absoluteUrl && !allowedShipStationUrl(absoluteUrl)) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: 'Refusing to fetch a non-ShipStation URL.',
      status: 400,
    };
  }

  const headers = requestHeaders({ credentials, accept: 'application/pdf, application/octet-stream, */*' });
  delete headers['Content-Type'];

  let response;
  try {
    response = await fetch(target, { method, headers });
  } catch {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Could not reach ShipStation. Try again in a moment.',
      status: 502,
    };
  }

  const buffer = await response.arrayBuffer();
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message: isV1 ? INVALID_KEY_MESSAGE_V1 : INVALID_KEY_MESSAGE_V2,
      status: 400,
    };
  }

  if (!response.ok) {
    let json = null;
    try {
      json = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      json = null;
    }
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: isV1
        ? formatShipStationErrorV1(json, response.status)
        : formatShipStationErrorV2(json, response.status),
      status: 502,
      detail: isV1
        ? shipStationErrorDetailV1(json, response.status)
        : shipStationErrorDetailV2(json, response.status),
    };
  }

  return {
    ok: true,
    data: {
      pdfBase64: bytesToBase64(buffer),
      contentType: contentType || 'application/pdf',
    },
  };
}

/** @deprecated Use INVALID_KEY_MESSAGE_V2 */
export const INVALID_KEY_MESSAGE = INVALID_KEY_MESSAGE_V2;
