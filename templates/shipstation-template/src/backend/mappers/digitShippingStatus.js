/**
 * Map ShipStation label `tracking_status` (and V1 orderStatus) onto Digit ShippingStatus.
 *
 * V2 labels: unknown | in_transit | error | delivered
 * (docs also mention delivered_to_service_point on GET /v2/tracking).
 * Digit: awaiting_carrier | awaiting_pickup | awaiting_drop_off | shipped | cancelled
 */

export function trackingStatusFromSsRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const labelStatus = record.tracking_status || record.trackingStatus;
  if (labelStatus) return String(labelStatus).toLowerCase();

  const orderStatus = String(record.orderStatus || '').toLowerCase();
  if (orderStatus === 'cancelled' || orderStatus === 'rejected_fulfillment') return 'voided';
  if (orderStatus === 'shipped') return 'in_transit';
  const tracking =
    record.trackingNumber ||
    record.tracking_number ||
    (Array.isArray(record.shipments) && record.shipments[0]?.trackingNumber);
  if (tracking) return 'in_transit';
  return null;
}

export function digitShippingStatusFromTrackingStatus(trackingStatus) {
  const value = String(trackingStatus || '').toLowerCase();
  switch (value) {
    case 'delivered':
    case 'delivered_to_service_point':
    case 'in_transit':
    case 'out_for_delivery':
    case 'at_delivery':
    case 'error':
    case 'exception':
      return 'shipped';
    case 'unknown':
    case 'created':
    case 'pending_pickup':
    case 'dispatched':
    case 'in_route_to_pickup':
    case 'at_pickup':
      return 'awaiting_pickup';
    case 'voided':
      return 'cancelled';
    default:
      return null;
  }
}

export function digitShippingStatusFromSs(normalized) {
  const trackingStatus =
    normalized?.trackingStatus || trackingStatusFromSsRecord(normalized?.raw);
  return digitShippingStatusFromTrackingStatus(trackingStatus);
}

export function trackingStatusLabel(trackingStatus) {
  switch (String(trackingStatus || '').toLowerCase()) {
    case 'unknown':
      return 'Unknown';
    case 'in_transit':
      return 'In transit';
    case 'delivered':
      return 'Delivered';
    case 'delivered_to_service_point':
      return 'Delivered to service point';
    case 'error':
    case 'exception':
      return 'Error';
    case 'voided':
      return 'Voided';
    default:
      return trackingStatus ? String(trackingStatus).replace(/_/g, ' ') : null;
  }
}
