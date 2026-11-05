import { AppErrorCode } from '@heysutton/sdk';
import { HandlerError } from '@heysutton/sdk-server';

const DEFAULT_API_URL = 'https://api.digit-software.com/graphql';
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
  const raw = env?.API_TOKEN_SUTTON;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    throw new HandlerError({
      code: AppErrorCode.MISSING_CONFIG,
      message: 'Add API_TOKEN_SUTTON in Sutton Studio settings, then reload this app.',
      status: 400,
    });
  }

  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(DEFAULT_API_URL, {
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
    const err = new Error(
      response.status === 429
        ? `Sutton API rate limit reached (still 429 after ${MAX_RETRIES} retries).`
        : `Sutton API HTTP ${response.status}`,
    );
    err.code = 'SUTTON_API';
    err.detail = { httpStatus: response.status, kind: 'http' };
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
    err.detail = { httpStatus: 200, kind: 'graphql', errors: payload.errors };
    throw err;
  }

  return payload?.data ?? null;
}
