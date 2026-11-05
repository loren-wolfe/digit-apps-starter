import { PUSH_STATUS_GROUP_ORDER } from './eligibility';

export const ALL_CARRIERS = '__all__';
export const NO_CARRIER = '__none__';
export const ALL_PUSH = '__all__';

/** Short names for the push-status facet. Group headers keep the longer sentences. */
export const PUSH_FACET_LABELS: Record<string, string> = {
  ready: 'Ready',
  blocked: 'Blocked',
  error: 'Failed',
  pushed: 'In ShipStation',
  label_ready: 'Label ready',
  imported: 'Imported',
  shipped: 'Shipped',
};

export type QueueSearchShipment = {
  documentNumber?: string | null;
  shippingNumber?: string | null;
  trackingNumber?: string | null;
  shippingCarrierField?: { value?: string | null } | null;
  order?: {
    documentNumber?: string | null;
    orderNumber?: string | null;
  } | null;
};

export type QueueSearchMap = {
  carrierName?: string | null;
  ssShipmentId?: string | null;
  trackingNumber?: string | null;
};

export function carrierOptionValue(shipment: QueueSearchShipment) {
  return shipment.shippingCarrierField?.value?.trim() || NO_CARRIER;
}

export function matchesCarrierFilter(shipment: QueueSearchShipment, filter: string) {
  if (!filter || filter === ALL_CARRIERS) return true;
  return carrierOptionValue(shipment) === filter;
}

/** Carrier, sales order, shipping order, ShipStation id, and tracking — not customer name. */
export function queueSearchHaystack(shipment: QueueSearchShipment, map?: QueueSearchMap | null) {
  return [
    shipment.shippingCarrierField?.value,
    map?.carrierName,
    shipment.order?.documentNumber,
    shipment.order?.orderNumber,
    shipment.documentNumber,
    shipment.shippingNumber,
    map?.ssShipmentId,
    shipment.trackingNumber,
    map?.trackingNumber,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function matchesQueueSearch(haystack: string, query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => haystack.includes(token));
}

export type QueueSection<T> = {
  key: string;
  label: string;
  items: T[];
};

export function sectionsByPushStatus<T>(
  items: T[],
  groupOf: (item: T) => { key: string; label: string },
): QueueSection<T>[] {
  const buckets = new Map<string, QueueSection<T>>();
  const extraKeys: string[] = [];
  for (const item of items) {
    const group = groupOf(item);
    const existing = buckets.get(group.key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    buckets.set(group.key, { key: group.key, label: group.label, items: [item] });
    if (!PUSH_STATUS_GROUP_ORDER.includes(group.key as (typeof PUSH_STATUS_GROUP_ORDER)[number])) {
      extraKeys.push(group.key);
    }
  }
  const ordered = [...PUSH_STATUS_GROUP_ORDER, ...extraKeys];
  return ordered.flatMap((key) => {
    const section = buckets.get(key);
    return section && section.items.length > 0 ? [section] : [];
  });
}
