import { suttonGraphql } from './suttonGraphql.js';

// Shared selection set — same fields whether the order is found by external order number
// (findOrderByExternalNumbers) or refetched fresh by its own known id (findOrderById).
const ORDER_MATCH_FIELDS = `
  id
  orderNumber
  orderStatus
  fulfillmentStatus
  createdAt
  shippingAddress { country }
  items {
    id
    quantity
    item { id name }
  }
  externalOrder {
    orderNumber
    connection { platform }
  }
`;

const FIND_ORDER_BY_EXTERNAL_NUMBER = `
  query ($externalOrderNumbers: [String!], $externalOrderPlatforms: [String!]) {
    orders(
      externalOrderNumbers: $externalOrderNumbers
      externalOrderPlatforms: $externalOrderPlatforms
      connection: { first: 1 }
    ) {
      nodes {
        ${ORDER_MATCH_FIELDS}
      }
    }
  }
`;

const FIND_ORDER_BY_ID = `
  query ($orderIds: [ID!]) {
    orders(orderIds: $orderIds, connection: { first: 1 }) {
      nodes {
        ${ORDER_MATCH_FIELDS}
      }
    }
  }
`;

/**
 * Refetches a Sutton order fresh by its own id — current address, status, items. Used by
 * "Rematch order" when the sync already knows which Sutton order it belongs to: refreshing by
 * id (instead of re-searching by external order number against a frozen, possibly-stale
 * snapshot) is both cheaper and actually picks up anything that changed in Sutton since the
 * row was first queued (e.g. a shipping address added after the fact).
 */
export async function findOrderById(env, orderId) {
  if (!orderId) return null;
  const data = await suttonGraphql({ env, query: FIND_ORDER_BY_ID, variables: { orderIds: [orderId] } });
  return data?.orders?.nodes?.[0] || null;
}

const ORDER_STATUSES_BY_IDS = `
  query ($orderIds: [ID!], $connection: ConnectionInput) {
    orders(orderIds: $orderIds, connection: $connection) {
      nodes { id orderNumber orderStatus }
    }
  }
`;

/** Current status of up to 100 Sutton orders. An id missing from the result was deleted. */
export async function findOrderStatusesByIds(env, orderIds) {
  if (!orderIds?.length) return [];
  const data = await suttonGraphql({
    env,
    query: ORDER_STATUSES_BY_IDS,
    variables: { orderIds, connection: { first: orderIds.length } },
  });
  return data?.orders?.nodes || [];
}

// Sutton orders not yet fulfilled or cancelled. These are the rows the fulfillment log
// shows as Awaiting completion until WooCommerce marks the order completed.
export const OPEN_ORDER_STATUSES = ['draft', 'requested', 'unfulfilled', 'partially_fulfilled'];

const OPEN_RUTTER_ORDERS = `
  query ($rutterConnectionIds: [ID!], $orderStatuses: [OrderStatus!], $connection: ConnectionInput) {
    orders(
      rutterConnectionIds: $rutterConnectionIds
      orderStatuses: $orderStatuses
      connection: $connection
    ) {
      nodes {
        id
        orderNumber
        orderStatus
        createdAt
        shippingAddress { country }
        externalOrder { orderNumber }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const RUTTER_CONNECTIONS = `
  query ($connection: ConnectionInput) {
    rutterConnections(connection: $connection) {
      nodes { id platform status storeUniqueName }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Rutter's own platform string for a WooCommerce connection.
const WOOCOMMERCE_RUTTER_PLATFORM = 'WOO_COMMERCE';

/**
 * The org's one WooCommerce Rutter connection id. Throws CONFIG_MISSING when there is none
 * and CONFIG_AMBIGUOUS when there is more than one.
 */
export async function resolveWooCommerceRutterConnectionId(env) {
  const all = [];
  let after = null;
  for (;;) {
    const data = await suttonGraphql({
      env,
      query: RUTTER_CONNECTIONS,
      variables: { connection: { first: 100, after } },
    });
    all.push(...(data?.rutterConnections?.nodes || []));
    if (!data?.rutterConnections?.pageInfo?.hasNextPage) break;
    after = data.rutterConnections.pageInfo.endCursor;
    if (!after) break;
  }
  const matches = all.filter((c) => c && c.platform === WOOCOMMERCE_RUTTER_PLATFORM);
  if (matches.length === 1) return matches[0].id;

  if (!matches.length) {
    const err = new Error('No WooCommerce Rutter connection found in this organization. Connect WooCommerce via Rutter in Sutton.');
    err.code = 'CONFIG_MISSING';
    throw err;
  }
  const candidates = matches.map((c) => `${c.id}${c.storeUniqueName ? ` (${c.storeUniqueName})` : ''}`).join(', ');
  const err = new Error(
    `Found ${matches.length} WooCommerce Rutter connections, so none can be selected: ${candidates}. Remove or disconnect the extra connection in Sutton.`
  );
  err.code = 'CONFIG_AMBIGUOUS';
  throw err;
}

/** Every open Sutton order on the given Rutter connection, all pages. */
export async function listOpenRutterOrders(env, { rutterConnectionId, pageSize = 100 } = {}) {
  const all = [];
  let after = null;
  for (;;) {
    const data = await suttonGraphql({
      env,
      query: OPEN_RUTTER_ORDERS,
      variables: {
        rutterConnectionIds: [rutterConnectionId],
        orderStatuses: OPEN_ORDER_STATUSES,
        connection: { first: pageSize, after },
      },
    });
    all.push(...(data?.orders?.nodes || []));
    if (!data?.orders?.pageInfo?.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
    if (!after) break;
  }
  return all;
}

// `RutterConnection.platform` is a free-form string set by Rutter per integration — it is
// not a fixed Sutton enum, so the strict query below only matches when the platform string
// is exactly what Rutter stored. A mismatch doesn't error — it just returns zero rows
// forever, which looks identical to "the order isn't in Sutton yet". To avoid that trap,
// fall back to an unfiltered-by-platform lookup and log the real platform string we find.
export async function findOrderByExternalNumbers(env, candidateNumbers, platform) {
  const externalOrderNumbers = [...new Set((candidateNumbers || []).map(String).filter(Boolean))];
  if (!externalOrderNumbers.length) return null;

  const runQuery = (externalOrderPlatforms) =>
    suttonGraphql({
      env,
      query: FIND_ORDER_BY_EXTERNAL_NUMBER,
      variables: { externalOrderNumbers, externalOrderPlatforms },
    });

  if (platform) {
    const strict = await runQuery([platform]);
    const strictMatch = strict.orders.nodes[0];
    if (strictMatch) return strictMatch;

    // Strict (number + platform) found nothing — retry on number alone. If that succeeds,
    // the configured platform string doesn't match what Rutter actually recorded for this
    // connection; surface that loudly instead of silently staying "unmatched" forever.
    const loose = await runQuery(null);
    const looseMatch = loose.orders.nodes[0];
    if (looseMatch) {
      const actualPlatform = looseMatch.externalOrder?.connection?.platform ?? null;
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          msg: 'fulfillment_platform_mismatch',
          configuredPlatform: platform,
          actualPlatform,
          matchedOrderId: looseMatch.id,
          matchedExternalOrderNumber: looseMatch.externalOrder?.orderNumber ?? null,
          hint: `Expected platform "${platform}" but this order's Rutter connection reports platform "${actualPlatform}". The order was matched by number alone.`,
        }),
      );
      return looseMatch;
    }
    return null;
  }

  const data = await runQuery(null);
  return data.orders.nodes[0] || null;
}

const UPDATE_ORDER_STATUS = `
  mutation ($input: UpdateOrderInput!) {
    updateOrder(input: $input) {
      order { id orderStatus }
    }
  }
`;

export async function markOrderFulfilled(env, orderId, { dryRun } = {}) {
  const variables = { input: { orderId, orderStatus: 'fulfilled' } };
  if (dryRun) return { dryRun: true, mutationName: 'updateOrder', query: UPDATE_ORDER_STATUS, variables };

  const data = await suttonGraphql({ env, query: UPDATE_ORDER_STATUS, variables });
  return data.updateOrder.order;
}

const ADJUST_INVENTORY = `
  mutation ($input: AdjustInventoryInput!) {
    adjustInventory(input: $input) {
      inventoryAdjustment { id documentNumber }
    }
  }
`;

export async function deductInventoryAtLocation(env, {
  itemId,
  warehouseLocationId,
  quantity,
  adjustmentReasonTermId,
  notes,
  dryRun,
}) {
  const variables = {
    input: {
      adjustInventory: { standardInventory: { itemId, warehouseLocationId } },
      quantityChange: -Math.abs(quantity),
      adjustmentReasonTermId,
      notes,
    },
  };
  if (dryRun) return { dryRun: true, mutationName: 'adjustInventory', query: ADJUST_INVENTORY, variables };

  const data = await suttonGraphql({ env, query: ADJUST_INVENTORY, variables });
  return data.adjustInventory.inventoryAdjustment;
}

/**
 * "Un-deduct" — issues a compensating, positive inventory adjustment to give stock back for a
 * line previously deducted via `deductInventoryAtLocation`. Same mutation, same shape, just
 * without negating the quantity. Used by the "Mark errant / Un-deduct" operator action — never
 * called automatically.
 */
export async function reverseInventoryAdjustment(env, {
  itemId,
  warehouseLocationId,
  quantity,
  adjustmentReasonTermId,
  notes,
  dryRun,
}) {
  const variables = {
    input: {
      adjustInventory: { standardInventory: { itemId, warehouseLocationId } },
      quantityChange: Math.abs(quantity),
      adjustmentReasonTermId,
      notes,
    },
  };
  if (dryRun) return { dryRun: true, mutationName: 'adjustInventory', query: ADJUST_INVENTORY, variables };

  const data = await suttonGraphql({ env, query: ADJUST_INVENTORY, variables });
  return data.adjustInventory.inventoryAdjustment;
}

/** Display name of the Sutton inventory adjustment reason used for fulfillment deductions. */
export const WOOCOMMERCE_ADJUSTMENT_REASON = 'WooCommerce Fulfillment';

/** Display name of the reason used for "Mark errant / Un-deduct" reversals. Kept separate from
 * WOOCOMMERCE_ADJUSTMENT_REASON so a reversal is never confused with a real deduction in
 * Sutton's adjustment history. */
export const WOOCOMMERCE_ADJUSTMENT_REVERSAL_REASON = 'WooCommerce Fulfillment Reversal';

const ADJUSTMENT_REASONS = `
  query {
    organizationDynamicFields {
      inventoryAdjustmentReasons {
        id
        options { id value deleted }
      }
    }
  }
`;

async function fetchInventoryAdjustmentReasonsField(env) {
  const data = await suttonGraphql({ env, query: ADJUSTMENT_REASONS });
  const field = data?.organizationDynamicFields?.inventoryAdjustmentReasons;
  return { fieldId: field?.id || null, options: field?.options || [] };
}

function activeOption(options, predicate) {
  return options.find((option) => option && option.deleted !== true && predicate(option)) || null;
}

const CREATE_ADJUSTMENT_REASON_OPTION = `
  mutation ($input: UnionCreateOrganizationDynamicFieldOptionInput!) {
    createOrganizationDynamicFieldOption(input: $input) {
      organizationDynamicFieldOption { id value }
    }
  }
`;

/**
 * Read-only status of the fulfillment adjustment reason, for `/fulfillment/config`. Never
 * creates anything. The reason is found by name or created on first apply, so it counts as
 * configured either way. `overrideId` is unused by this app.
 */
export async function adjustmentReasonStatus(env, { overrideId, cachedId } = {}) {
  const { options } = await fetchInventoryAdjustmentReasonsField(env);
  if (overrideId) {
    const match = activeOption(options, (option) => option.id === overrideId);
    return { configured: Boolean(match), id: match?.id || null, source: 'override' };
  }
  const match =
    (cachedId && activeOption(options, (option) => option.id === cachedId)) ||
    activeOption(options, (option) => option.value === WOOCOMMERCE_ADJUSTMENT_REASON);
  return { configured: true, id: match?.id || null, source: match ? 'name' : 'autoCreate' };
}

/**
 * Resolves the Sutton option id for an inventory adjustment reason by display `value`,
 * creating it when it does not exist yet. `overrideId` (from an env override) wins and is
 * never auto-created: a missing override throws CONFIG_MISSING so the operator fixes the
 * secret instead of the app silently using a different reason. `cachedId` skips the name
 * search when it is still active; `onResolved` lets the caller persist a newly found id.
 */
export async function findOrCreateAdjustmentReasonTermId(env, { value, overrideId, overrideKey, cachedId, onResolved } = {}) {
  const { fieldId, options } = await fetchInventoryAdjustmentReasonsField(env);

  if (overrideId) {
    if (activeOption(options, (option) => option.id === overrideId)) return overrideId;
    const err = new Error(
      `${overrideKey || 'The adjustment reason override'} is set to "${overrideId}", but that inventory adjustment reason is not an active option in Sutton. Fix or remove the secret in Sutton Studio Settings.`,
    );
    err.code = 'CONFIG_MISSING';
    throw err;
  }

  if (cachedId && activeOption(options, (option) => option.id === cachedId)) return cachedId;

  const byName = activeOption(options, (option) => option.value === value);
  if (byName) {
    if (onResolved) await onResolved(byName.id);
    return byName.id;
  }

  if (!fieldId) {
    const err = new Error(
      `Could not resolve the "inventoryAdjustmentReasons" dynamic field id in Sutton — cannot auto-create the "${value}" adjustment reason.`,
    );
    err.code = 'CONFIG_MISSING';
    throw err;
  }

  const data = await suttonGraphql({
    env,
    query: CREATE_ADJUSTMENT_REASON_OPTION,
    variables: { input: { organizationDynamicTermId: fieldId, value } },
  });
  const created = data?.createOrganizationDynamicFieldOption?.organizationDynamicFieldOption;
  if (!created?.id) {
    const err = new Error(`Failed to create the "${value}" adjustment reason in Sutton.`);
    err.code = 'SUTTON_API';
    throw err;
  }
  if (onResolved) await onResolved(created.id);
  return created.id;
}

const STOCK_AT_LOCATION = `
  query ($itemIds: [ID!], $warehouseLocationIds: [ID!]) {
    inventories(
      itemIds: $itemIds
      warehouseLocationIds: $warehouseLocationIds
      connection: { first: 100 }
    ) {
      nodes { quantityInStock item { id } }
    }
  }
`;

export async function fetchStockAtLocation(env, { itemIds, warehouseLocationId }) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const data = await suttonGraphql({
    env,
    query: STOCK_AT_LOCATION,
    variables: { itemIds: ids, warehouseLocationIds: [warehouseLocationId] },
  });

  const stock = new Map();
  for (const node of data.inventories.nodes || []) {
    const itemId = node.item?.id;
    if (!itemId) continue;
    stock.set(itemId, (stock.get(itemId) || 0) + (node.quantityInStock || 0));
  }
  return stock;
}

/** Display names used to find the item custom field that marks an item as a Virtual Kit. */
export const KIT_TYPE_FIELD_NAME = 'Kit Type';
export const VIRTUAL_KIT_OPTION_VALUE = 'Virtual Kit';

// Query.itemCustomFields and Query.items reject connection.first above 250
// ("Page size cannot be greater than 250"). Bom.items is the exception and allows 1000.
const SUTTON_CONNECTION_MAX = 250;

const ITEM_CUSTOM_FIELDS = `
  query ($connection: ConnectionInput) {
    itemCustomFields(connection: $connection) {
      nodes { id name options { id value deleted } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/**
 * Resolves the Kit Type field and its Virtual Kit option. Env overrides win; otherwise both are
 * found by name. Returns `{ fieldId, optionId }`, or null when the org has no such field or
 * option — kit detection is then off and every order line deducts as a plain item.
 */
export async function resolveKitTypeField(env, { fieldIdOverride, optionIdOverride } = {}) {
  let after = null;
  for (;;) {
    const data = await suttonGraphql({
      env,
      query: ITEM_CUSTOM_FIELDS,
      variables: { connection: { first: SUTTON_CONNECTION_MAX, after } },
    });
    const fields = data?.itemCustomFields?.nodes || [];
    const field = fields.find((f) =>
      f && (fieldIdOverride ? f.id === fieldIdOverride : sameName(f.name, KIT_TYPE_FIELD_NAME)),
    );
    if (field) {
      const option = (field.options || []).find(
        (o) =>
          o &&
          o.deleted !== true &&
          (optionIdOverride ? o.id === optionIdOverride : sameName(o.value, VIRTUAL_KIT_OPTION_VALUE)),
      );
      return option ? { fieldId: field.id, optionId: option.id } : null;
    }
    if (!data?.itemCustomFields?.pageInfo?.hasNextPage) return null;
    after = data.itemCustomFields.pageInfo.endCursor;
    if (!after) return null;
  }
}

// One level of `fulfillmentItem` nesting is fetched alongside each item's own
// fields — enough to resolve a single alias → fulfillment-item hop without a
// second round trip. BOM components are fetched as id/name/sku/trackingMethod
// only. Nested virtual kits are expanded by re-fetching each component with
// this same query (see resolveOrderLines), not by nesting BOMs in GraphQL.
const ITEM_FULFILLMENT_OWN_FIELDS = `
  id
  name
  sku
  trackingMethod
  customFields { fieldId fieldValueOption { id } }
  boms(isDefault: true) {
    isDefault
    items(connection: { first: 1000 }) {
      nodes {
        quantity
        item { id name sku trackingMethod }
      }
    }
  }
`;

const ITEM_FULFILLMENT_DETAILS = `
  query ($itemIds: [ID!]) {
    items(itemIds: $itemIds, connection: { first: ${SUTTON_CONNECTION_MAX} }) {
      nodes {
        ${ITEM_FULFILLMENT_OWN_FIELDS}
        fulfillmentItem {
          ${ITEM_FULFILLMENT_OWN_FIELDS}
        }
      }
    }
  }
`;

/**
 * Batch-fetch alias/kit/BOM details for a set of item ids.
 * Returns a Map keyed by the requested item id. Item ids are requested in
 * chunks of SUTTON_CONNECTION_MAX so Query.items never asks for a page over 250.
 */
export async function fetchItemFulfillmentDetails(env, itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const byId = new Map();
  for (let offset = 0; offset < ids.length; offset += SUTTON_CONNECTION_MAX) {
    const chunk = ids.slice(offset, offset + SUTTON_CONNECTION_MAX);
    const data = await suttonGraphql({
      env,
      query: ITEM_FULFILLMENT_DETAILS,
      variables: { itemIds: chunk },
    });
    const nodes = data?.items?.nodes || [];
    for (const node of nodes) {
      if (node?.id) byId.set(node.id, node);
    }
  }
  return byId;
}

const WAREHOUSE_LOCATION_BY_ID = `
  query ($warehouseLocationId: ID!) {
    warehouseLocation(warehouseLocationId: $warehouseLocationId) {
      id locationCode type deleted
    }
  }
`;

/**
 * Looks up the configured warehouse location. Returns the location, or null when Sutton
 * reports it does not exist (a GraphQL error, or a deleted location). Transport and auth
 * failures still throw, so a caller can tell "wrong id" apart from "could not check".
 */
export async function findWarehouseLocationById(env, warehouseLocationId) {
  if (!warehouseLocationId) return null;
  try {
    const data = await suttonGraphql({
      env,
      query: WAREHOUSE_LOCATION_BY_ID,
      variables: { warehouseLocationId },
    });
    const location = data?.warehouseLocation || null;
    return location && location.deleted !== true ? location : null;
  } catch (err) {
    if (err?.detail?.errors) return null;
    throw err;
  }
}
