/**
 * Worker → Digit GraphQL using JWT_TOKEN (a Clerk user JWT). Digit staff generate this
 * token and place it in the organization's app secrets. Webhooks/schedules have no
 * iframe session. Never log the token. Never call this from the frontend.
 */

import { AppErrorCode } from '@heysutton/sdk';
import { HandlerError } from '@heysutton/sdk-server';

import { loadJwtToken, shipstationDb } from './runtimeConfig.js';

const DEFAULT_API_URL_DIGIT = 'https://api.digit-software.com/graphql';

const MAX_RETRIES = 2;

export function digitApiUrl() {
  return DEFAULT_API_URL_DIGIT;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response, attempt) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5000);
  return 500 * 2 ** attempt;
}

/**
 * @returns {Promise<
 *   | { ok: true, data: unknown }
 *   | { ok: false, code: string, message: string, status: number }
 * >}
 */
export async function digitGraphql({ env, query, variables }) {
  const db = shipstationDb({ env });
  const token = await loadJwtToken({ env, db });
  if (!token) {
    throw new HandlerError({
      code: AppErrorCode.MISSING_CONFIG,
      message:
        'Add the JWT_TOKEN app secret in Sutton so this app can write tracking back from ShipStation. Sutton staff generate this token and place it on the account.',
      status: 503,
    });
  }

  const url = digitApiUrl();

  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      return {
        ok: false,
        code: AppErrorCode.UPSTREAM_ERROR,
        message: 'Could not reach the Sutton API. Try again in a moment.',
        status: 502,
      };
    }
    if (response.status !== 429 || attempt >= MAX_RETRIES) break;
    await sleep(retryAfterMs(response, attempt));
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: AppErrorCode.VALIDATION_ERROR,
      message:
        'The Sutton JWT was rejected. Ask Sutton staff to generate JWT_TOKEN and place it in this organization’s app secrets.',
      status: 400,
    };
  }

  if (response.status === 429) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Sutton API rate limit reached. This run stopped early and will resume on the next sync.',
      status: 429,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: `Sutton API request failed (HTTP ${response.status}).`,
      status: 502,
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: 'Sutton API returned a non-JSON body.',
      status: 502,
    };
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const raw =
      typeof first?.message === 'string' && first.message
        ? first.message
        : 'Sutton GraphQL request failed.';
    const extCode =
      first?.extensions && typeof first.extensions.code === 'string' ? first.extensions.code : null;
    return {
      ok: false,
      code: AppErrorCode.UPSTREAM_ERROR,
      message: extCode ? `[${extCode}] ${raw}` : raw,
      status: 502,
      detail: { graphqlCode: extCode },
    };
  }

  return { ok: true, data: payload?.data ?? null };
}
