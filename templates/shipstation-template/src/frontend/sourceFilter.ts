/** Keep in sync with src/backend/sourceFilter.js — the Worker cannot import this file. */

export const MANUAL_SOURCE = 'manual';
export const MANUAL_SOURCE_LABEL = 'Manual Entry';

export const SOURCE_EXCLUDED_REASON =
  'This sales order source is not selected in Settings, so the shipment is not routed to ShipStation.';

const PLATFORM_NAMES: Record<string, string> = {
  SHOPIFY: 'Shopify',
  WOO_COMMERCE: 'WooCommerce',
  EBAY: 'eBay',
  AMAZON: 'Amazon',
};

export const COMMERCE_PLATFORMS = new Set(Object.keys(PLATFORM_NAMES));

const IN_SHIPSTATION_STATUSES = new Set(['pushed', 'label_ready', 'shipped', 'imported']);

export type SourceConnection = {
  id?: string | null;
  platform?: string | null;
  storeUniqueName?: string | null;
};

export type SourceFilterSettings = {
  enabled: boolean;
  keys: string[];
};

export type ShipmentForSource = {
  order?: {
    externalOrder?: { connection?: SourceConnection | null } | null;
  } | null;
};

export type MapRowForSource = {
  pushStatus?: string | null;
  ssShipmentId?: string | null;
};

export function shipmentSourceKey(shipment: ShipmentForSource | null | undefined) {
  const id = shipment?.order?.externalOrder?.connection?.id;
  return id ? String(id) : MANUAL_SOURCE;
}

export function shipmentSourceConnection(shipment: ShipmentForSource | null | undefined) {
  return shipment?.order?.externalOrder?.connection ?? null;
}

function titleCase(text: string) {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function storeDisplayName(storeUniqueName: string | null | undefined) {
  if (!storeUniqueName) return '';
  const slug = String(storeUniqueName).split('.')[0].replace(/-/g, ' ').trim();
  return slug ? titleCase(slug) : '';
}

/** Platform first (Shopify, Amazon, …), then the store name when one exists. */
export function sourceLabel(connection: SourceConnection | null | undefined) {
  if (!connection) return MANUAL_SOURCE_LABEL;
  const platform = String(connection.platform || '').toUpperCase();
  const platformName = PLATFORM_NAMES[platform] || connection.platform || 'Unknown source';
  const storeName = storeDisplayName(connection.storeUniqueName);
  if (!storeName || storeName.toLowerCase() === platformName.toLowerCase()) return platformName;
  return `${platformName} · ${storeName}`;
}

export function isCommerceConnection(connection: SourceConnection | null | undefined) {
  return COMMERCE_PLATFORMS.has(String(connection?.platform || '').toUpperCase());
}

export function inShipStation(mapRow: MapRowForSource | null | undefined) {
  if (!mapRow) return false;
  return Boolean(mapRow.ssShipmentId) || IN_SHIPSTATION_STATUSES.has(mapRow.pushStatus ?? '');
}

/**
 * True when the source filter is on and this shipment's source is not selected.
 * Shipments already in ShipStation are never excluded, so labels and tracking stay reachable.
 */
export function sourceExcluded({
  shipment,
  sourceFilter,
  mapRow = null,
}: {
  shipment: ShipmentForSource | null | undefined;
  sourceFilter: SourceFilterSettings | null | undefined;
  mapRow?: MapRowForSource | null;
}) {
  if (!sourceFilter?.enabled || !sourceFilter.keys?.length) return false;
  if (inShipStation(mapRow)) return false;
  return !sourceFilter.keys.includes(shipmentSourceKey(shipment));
}
