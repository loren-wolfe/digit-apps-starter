import { AppErrorCode } from '@heysutton/sdk';
import { HandlerError, requireEnv } from '@heysutton/sdk-server';

const DEFAULT_API_URL = 'https://api.digit-software.com/graphql';
// 429s are expected to clear within a few seconds once a caller backs off — this is
// deliberately higher than a single interactive request would want so a scheduled batch
// (woocommerce-poll) self-heals from a transient rate-limit spike instead of failing the
// whole candidate outright. Pair with pacing between calls in the caller, not just retries
// here — retries alone don't stop a tight loop from re-triggering the limit immediately.
const MAX_RETRIES = 4;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response, attempt) {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 8000);
  return Math.min(500 * 2 ** attempt, 8000);
}

export async function suttonGraphql({ env, query, variables }) {
  const token = requireEnv({ env, key: 'API_TOKEN_SUTTON' });
  const url = DEFAULT_API_URL;

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
      const err = new Error('Could not reach the Sutton API.');
      err.code = 'SUTTON_API';
      throw err;
    }
    if (response.status !== 429 || attempt >= MAX_RETRIES) break;
    await sleep(retryAfterMs(response, attempt));
  }

  if (response.status === 401 || response.status === 403) {
    throw new HandlerError({
      code: AppErrorCode.MISSING_CONFIG,
      message: 'API_TOKEN_SUTTON was rejected. Update the app secret.',
      status: 400,
    });
  }

  if (!response.ok) {
    const rateLimited = response.status === 429;
    const err = new Error(
      rateLimited
        ? `Sutton API rate limit reached (still 429 after ${MAX_RETRIES} retries). This call will be retried on the next reconcile tick or manual retry.`
        : `Sutton API HTTP ${response.status}`
    );
    err.code = 'SUTTON_API';
    err.detail = { httpStatus: response.status };
    throw err;
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const err = new Error('Sutton API returned a non-JSON body.');
    err.code = 'SUTTON_API';
    throw err;
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const raw = typeof first?.message === 'string' ? first.message : 'Sutton GraphQL request failed.';
    const err = new Error(`Sutton GraphQL error: ${raw}`);
    err.code = 'SUTTON_API';
    err.detail = { errors: payload.errors, extensions: first.extensions || null };
    throw err;
  }

  return payload?.data ?? null;
}
