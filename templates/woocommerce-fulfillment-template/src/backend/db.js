import { requireEnv } from '@heysutton/sdk-server';

const JSON_COLS = new Set([
  'headers',
  'payload',
  'items_preview',
  'error_detail',
  'applied_items',
  'matched_external_numbers',
  'reversed_items',
]);

const BOOL_COLS = new Set(['signature_valid', 'order_status_applied', 'ok', 'auto_deduct_enabled']);

export function fulfillmentDb(env) {
  return requireEnv({ env, key: 'WOOCOMMERCE_FULFILLMENT_DB' });
}

export function hydrateRow(row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of JSON_COLS) {
    if (col in out && typeof out[col] === 'string' && out[col]) {
      try {
        out[col] = JSON.parse(out[col]);
      } catch {
        /* keep string */
      }
    }
  }
  for (const col of BOOL_COLS) {
    if (col in out && out[col] != null) out[col] = Boolean(out[col]);
  }
  return out;
}

function bindable(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Postgres-style `$1` SQL for D1. Expands `col = ANY($n::text[])` when that
 * argument is an array. `now()` becomes `datetime('now')`.
 */
export async function d1Query(d1, sql, params = []) {
  // Strip Postgres casts, including array casts like `::text[]` — leaving the
  // trailing `[]` behind breaks the `ANY($n)` match below, which makes the
  // array parameter fall through to `bindable()` (JSON.stringify) instead of
  // being expanded into `IN (...)`, landing a literal `[]` in the SQL text
  // and tripping a D1 "near \"[]\": syntax error".
  let text = sql.replace(/\bnow\(\)/gi, "datetime('now')").replace(/::\w+(\[\])?/g, '');

  // A single query can carry more than one `col = ANY($n)` (e.g. filtering by both status
  // and location at once) — matching only the first occurrence left every later one
  // un-expanded, so its array param fell through to `bindable()` (JSON.stringify) instead of
  // `IN (...)`, same failure mode as the `::text[]` cast bug above. Replace all of them.
  const arrayIndexes = new Set();
  text = text.replace(/(\w+)\s*=\s*ANY\(\$(\d+)\)/gi, (full, col, idxStr) => {
    const idx = Number(idxStr);
    arrayIndexes.add(idx);
    const arr = Array.isArray(params[idx - 1]) ? params[idx - 1] : [];
    return arr.length ? `${col} IN (${arr.map(() => `$${idx}`).join(', ')})` : '0';
  });

  const arrayCursor = {};
  const bind = [];
  const finalSql = text.replace(/\$(\d+)/g, (_m, num) => {
    const n = Number(num);
    if (arrayIndexes.has(n) && Array.isArray(params[n - 1])) {
      const k = arrayCursor[n] || 0;
      arrayCursor[n] = k + 1;
      bind.push(bindable(params[n - 1][k]));
    } else {
      bind.push(bindable(params[n - 1]));
    }
    return '?';
  });

  const stmt = bind.length ? d1.prepare(finalSql).bind(...bind) : d1.prepare(finalSql);
  if (sql.trim().toUpperCase().startsWith('SELECT') || /RETURNING\b/i.test(sql)) {
    const { results } = await stmt.all();
    return { rows: (results || []).map(hydrateRow) };
  }
  await stmt.run();
  return { rows: [] };
}

export function dbAdapter(env) {
  const d1 = fulfillmentDb(env);
  return {
    query: (sql, params) => d1Query(d1, sql, params),
    d1,
  };
}
