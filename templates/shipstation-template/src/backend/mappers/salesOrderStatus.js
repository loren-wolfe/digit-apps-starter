/**
 * Sales order status after a ShipStation label is written onto one Sutton shipment.
 *
 * The shipment that just received the label is excluded. A newly purchased label
 * often maps to `awaiting_pickup`, and that shipment still counts as fulfilled
 * for this decision. Sibling shipments that are not `shipped` — including
 * `cancelled` — keep the order partially fulfilled.
 *
 * Returns null when this writeback is a void (`shippingStatus` cancelled) so the
 * caller leaves the sales order status unchanged.
 */
export function salesOrderStatusAfterLabelReturn({ shipments, currentShipmentId }) {
  const list = Array.isArray(shipments) ? shipments : [];
  const current = currentShipmentId
    ? list.find((shipment) => shipment?.id === currentShipmentId)
    : null;
  if (current?.shippingStatus === 'cancelled') return null;

  const others = list.filter((shipment) => shipment?.id !== currentShipmentId);
  if (others.length === 0) return 'fulfilled';
  if (others.every((shipment) => shipment?.shippingStatus === 'shipped')) return 'fulfilled';
  return 'partially_fulfilled';
}
