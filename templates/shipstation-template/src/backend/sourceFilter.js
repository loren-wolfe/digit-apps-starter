/** Keep in sync with src/frontend/sourceFilter.ts */

export const MANUAL_SOURCE = 'manual';
export const MANUAL_SOURCE_LABEL = 'Manual Entry';
export const MAX_SOURCE_FILTER_KEYS = 50;

export const SOURCE_EXCLUDED_REASON =
  'This sales order source is not selected in Settings, so the shipment is not routed to ShipStation.';

const PLATFORM_NAMES = {
  SHOPIFY: 'Shopify',
  WOO_COMMERCE: 'WooCommerce',
  EBAY: 'eBay',
  AMAZON: 'Amazon',
};

export const COMMERCE_PLATFORMS = new Set(Object.keys(PLATFORM_NAMES));

const IN_SHIPSTATION_STATUSES = new Set(['pushed', 'label_ready', 'shipped', 'imported']);

/** Sutton commerce connection id the sales order came from, or `manual` when there is none. */
export function shipmentSourceKey(shipment) {
  const id = shipment?.order?.externalOrder?.connection?.id;
  return id ? String(id) : MANUAL_SOURCE;
}

function titleCase(text) {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function storeDisplayName(storeUniqueName) {
  if (!storeUniqueName) return '';
  const slug = String(storeUniqueName).split('.')[0].replace(/-/g, ' ').trim();
  return slug ? titleCase(slug) : '';
}

/** Platform first (Shopify, Amazon, …), then the store name when one exists. */
export function sourceLabel(connection) {
  if (!connection) return MANUAL_SOURCE_LABEL;
  const platform = String(connection.platform || '').toUpperCase();
  const platformName = PLATFORM_NAMES[platform] || connection.platform || 'Unknown source';
  const storeName = storeDisplayName(connection.storeUniqueName);
  if (!storeName || storeName.toLowerCase() === platformName.toLowerCase()) return platformName;
  return `${platformName} · ${storeName}`;
}

/** Stored columns → `{ enabled, keys }`. Unreadable keys turn the filter off. */
export function normalizeSourceFilter(enabledValue, keysValue) {
  let keys = [];
  if (Array.isArray(keysValue)) {
    keys = keysValue;
  } else if (typeof keysValue === 'string' && keysValue.trim()) {
    try {
      const parsed = JSON.parse(keysValue);
      if (!Array.isArray(parsed)) return { enabled: false, keys: [] };
      keys = parsed;
    } catch {
      return { enabled: false, keys: [] };
    }
  }
  const clean = [...new Set(keys.map((key) => String(key ?? '').trim()).filter(Boolean))];
  const enabled = Boolean(Number(enabledValue)) && clean.length > 0;
  return { enabled, keys: clean };
}

export function inShipStation(mapRow) {
  if (!mapRow) return false;
  const ssShipmentId = mapRow.ssShipmentId ?? mapRow.ss_shipment_id ?? null;
  const status = mapRow.pushStatus ?? mapRow.push_status ?? null;
  return Boolean(ssShipmentId) || IN_SHIPSTATION_STATUSES.has(status);
}

/**
 * True when the source filter is on and this shipment's source is not selected.
 * Shipments already in ShipStation are never excluded, so labels and tracking stay reachable.
 */
export function sourceExcluded({ shipment, orgSettings, mapRow = null }) {
  const filter = orgSettings?.sourceFilter;
  if (!filter?.enabled || !filter.keys?.length) return false;
  if (inShipStation(mapRow)) return false;
  return !filter.keys.includes(shipmentSourceKey(shipment));
}
