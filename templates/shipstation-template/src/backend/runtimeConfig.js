/**
 * App config. ShipStation and Digit secrets are managed in Digit's built-in App Secrets
 * UI and reach the Worker as `env.KEY` only — do not fall back to D1 `app_config` for
 * those keys (legacy rows are deleted by migration 0007). `app_config` still holds the
 * generated ENCRYPTION_KEY used to decrypt legacy connection ciphertext.
 * Do not use a DIGIT_ prefix — Digit reserves it for platform bindings.
 */

import { optionalEnv } from '@heysutton/sdk-server';

import { decryptSecret, generateEncryptionKeyB64, parseEncryptionKey } from './crypto.js';

export const CONFIG = {
  encryptionKey: 'ENCRYPTION_KEY',
  jwtToken: 'JWT_TOKEN',
  shipStationApiKey: 'SHIPSTATION_API_KEY',
  shipStationApiSecret: 'SHIPSTATION_API_SECRET',
  faireApiKey: 'FAIRE_API_KEY',
};

/** App secret keys per channel adapter id. Never expose values in API responses. */
export const CHANNEL_SECRETS = {
  faire: ['FAIRE_API_KEY'],
  shopify: ['SHOPIFY_ACCESS_TOKEN'],
  woocommerce: ['WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET'],
};

export function shipstationDb({ env }) {
  return optionalEnv({ env, key: 'SHIPSTATION_DB' }) || null;
}

async function configRow({ db, key }) {
  if (!db) return null;
  return db.prepare(`SELECT key, value, encrypted FROM app_config WHERE key = ?`).bind(key).first();
}

async function upsertConfig({ db, key, value, encrypted }) {
  await db
    .prepare(
      `INSERT INTO app_config (key, value, encrypted, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         encrypted = excluded.encrypted,
         updated_at = excluded.updated_at`,
    )
    .bind(key, value, encrypted ? 1 : 0)
    .run();
}

export async function loadEncryptionKeyBytes({ env, db }) {
  const fromEnv = optionalEnv({ env, key: 'APP_SECRET_ENCRYPTION_KEY' });
  if (fromEnv) return parseEncryptionKey({ raw: fromEnv });
  const row = await configRow({ db, key: CONFIG.encryptionKey });
  if (!row?.value) return null;
  return parseEncryptionKey({ raw: row.value });
}

export async function ensureEncryptionKeyBytes({ env, db }) {
  const existing = await loadEncryptionKeyBytes({ env, db });
  if (existing) return existing;
  const raw = generateEncryptionKeyB64();
  await upsertConfig({ db, key: CONFIG.encryptionKey, value: raw, encrypted: false });
  return parseEncryptionKey({ raw });
}

/**
 * `source` tells the setup screen where a live value came from: `appSecret` is a Digit
 * app secret/env var injected into the Worker, `appDatabase` is a legacy D1 row (only
 * when `dbFallback` is true — channel secrets may still use it; core setup secrets do not).
 *
 * @returns {Promise<{ value: string | null, source: 'appSecret' | 'appDatabase' | null }>}
 */
async function readStored({ env, db, key, envKeys, encrypted, dbFallback = true }) {
  for (const envKey of envKeys) {
    const fromEnv = optionalEnv({ env, key: envKey });
    // Only non-empty strings count — ignore platform object bindings and blank secrets.
    if (typeof fromEnv === 'string') {
      const trimmed = fromEnv.trim();
      if (trimmed) return { value: trimmed, source: 'appSecret' };
    }
  }
  if (!dbFallback) return { value: null, source: null };
  const row = await configRow({ db, key });
  if (!row?.value) return { value: null, source: null };
  if (encrypted || row.encrypted) {
    const keyBytes = await loadEncryptionKeyBytes({ env, db });
    if (!keyBytes) return { value: null, source: null };
    try {
      return {
        value: await decryptSecret({ stored: row.value, keyBytes }),
        source: 'appDatabase',
      };
    } catch {
      return { value: null, source: null };
    }
  }
  return { value: row.value, source: 'appDatabase' };
}

async function loadStored(args) {
  return (await readStored(args)).value;
}

/** Core setup secrets: Digit App Secrets only (no D1 ghost after removal). */
const JWT_TOKEN_SOURCE = {
  key: CONFIG.jwtToken,
  // Do not also read DIGIT_API_TOKEN — DIGIT_ is reserved for platform bindings.
  envKeys: [CONFIG.jwtToken],
  encrypted: true,
  dbFallback: false,
};

const SHIPSTATION_API_KEY_SOURCE = {
  key: CONFIG.shipStationApiKey,
  envKeys: [CONFIG.shipStationApiKey],
  encrypted: true,
  dbFallback: false,
};

const SHIPSTATION_API_SECRET_SOURCE = {
  key: CONFIG.shipStationApiSecret,
  envKeys: [CONFIG.shipStationApiSecret],
  encrypted: true,
  dbFallback: false,
};

export async function loadJwtToken({ env, db }) {
  return loadStored({ env, db, ...JWT_TOKEN_SOURCE });
}

export async function readJwtToken({ env, db }) {
  return readStored({ env, db, ...JWT_TOKEN_SOURCE });
}

export async function loadShipStationApiKey({ env, db }) {
  return loadStored({ env, db, ...SHIPSTATION_API_KEY_SOURCE });
}

export async function readShipStationApiKey({ env, db }) {
  return readStored({ env, db, ...SHIPSTATION_API_KEY_SOURCE });
}

export async function loadShipStationApiSecret({ env, db }) {
  return loadStored({ env, db, ...SHIPSTATION_API_SECRET_SOURCE });
}

export async function readShipStationApiSecret({ env, db }) {
  return readStored({ env, db, ...SHIPSTATION_API_SECRET_SOURCE });
}

/**
 * Key alone → V2. Key + secret → V1. Missing key → null.
 * @returns {Promise<null | { apiVersion: 'v1' | 'v2', apiKey: string, apiSecret?: string }>}
 */
export async function resolveShipStationCredentials({ env, db }) {
  const apiKey = await loadShipStationApiKey({ env, db });
  if (!apiKey) return null;
  const apiSecret = await loadShipStationApiSecret({ env, db });
  if (apiSecret) {
    return { apiVersion: 'v1', apiKey, apiSecret };
  }
  return { apiVersion: 'v2', apiKey };
}

export async function loadFaireApiKey({ env, db }) {
  return loadStored({
    env,
    db,
    key: CONFIG.faireApiKey,
    envKeys: [CONFIG.faireApiKey],
    encrypted: true,
  });
}

/**
 * @param {object} args
 * @param {Record<string, unknown>} args.env
 * @param {import('@cloudflare/workers-types').D1Database | null} args.db
 * @param {string} args.channelId
 * @returns {Promise<Array<{ key: string, present: boolean, source: 'appSecret' | 'appDatabase' | null }>>}
 */
export async function readChannelSecrets({ env, db, channelId }) {
  const keys = CHANNEL_SECRETS[channelId] || [];
  const entries = [];
  for (const key of keys) {
    const stored = await readStored({
      env,
      db,
      key,
      envKeys: [key],
      encrypted: true,
    });
    entries.push({
      key,
      present: Boolean(stored.value),
      source: stored.source,
    });
  }
  return entries;
}

/**
 * @param {object} args
 * @param {Record<string, unknown>} args.env
 * @param {import('@cloudflare/workers-types').D1Database | null} args.db
 * @param {string} args.channelId
 * @param {string} args.secretKey
 */
export async function readChannelSecret({ env, db, channelId, secretKey }) {
  const allowed = CHANNEL_SECRETS[channelId] || [];
  if (!allowed.includes(secretKey)) {
    return { value: null, source: null };
  }
  return readStored({
    env,
    db,
    key: secretKey,
    envKeys: [secretKey],
    encrypted: true,
  });
}

