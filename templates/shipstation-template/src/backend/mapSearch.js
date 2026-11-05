export const MAP_SEARCH_LIMIT = 25;

/** Bound pattern for a contains match. `%`, `_`, and `\\` in the query stay literal. */
export function mapSearchLikePattern(query) {
  const text = String(query ?? '').trim();
  if (!text) return null;
  const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

export async function queryMapsBySearch({ db, connectionId, query, selectSql, mapRow }) {
  const pattern = mapSearchLikePattern(query);
  if (!pattern || !connectionId) return [];
  const { results } = await db
    .prepare(
      `${selectSql}
       WHERE connection_id = ? AND deleted = 0
         AND (
           IFNULL(ss_shipment_id, '') LIKE ? ESCAPE '\\'
           OR IFNULL(tracking_number, '') LIKE ? ESCAPE '\\'
         )
       LIMIT ${MAP_SEARCH_LIMIT}`,
    )
    .bind(connectionId, pattern, pattern)
    .all();
  return (results ?? []).map((row) => mapRow(row)).filter(Boolean);
}
