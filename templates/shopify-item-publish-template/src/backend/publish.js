import {
  actionLabel,
  adminProductUrl,
  imageUrls,
  metafieldsFor,
  normalizeMapping,
  planStore,
  previewValues,
  priceString,
  shopDomain,
  suttonIdSentence,
  suttonIdWrites,
  variantRowsFor,
  fieldText,
  memberIdsFor,
  normalizeVariantIds,
  publishGroup,
  STYLE_COLOR_FIELD,
} from './mapping.js';
import { loadItem, loadStyleSiblings, writeShopifyIds } from './sutton.js';
import {
  addMissingOptionValues,
  createDraftProduct,
  createVariants,
  fetchProduct,
  findVariantsBySkus,
  listProductMetafieldDefinitions,
  probeStore,
  readStores,
  deleteProductMetafields,
  updateProductFields,
  updateVariants,
} from './shopify.js';

function variantInput(row, { id, includePrice }) {
  const input = {
    optionValues: (row.optionValues || []).map((pair) => ({ optionName: pair.name, name: pair.value })),
    inventoryItem: { sku: row.sku },
  };
  if (id) input.id = id;
  input.barcode = row.barcode || '';
  if (includePrice && row.price != null && row.price > 0) {
    input.price = priceString(row.price);
  }
  return input;
}

function withMetafields(plan, item, definitions) {
  const built = metafieldsFor(item, definitions);
  return {
    ...plan,
    metafields: built.metafields,
    metafieldsToClear: built.clear,
    skippedMetafields: built.skipped,
  };
}

function productPayload(plan) {
  return { ...plan.productFields, metafields: plan.metafields || [] };
}

function skippedSentence(skipped) {
  if (!Array.isArray(skipped) || skipped.length === 0) return '';
  const names = skipped.map((entry) => `${entry.shopify} (${entry.reason})`).join(', ');
  return ` These product fields were not written: ${names}.`;
}

async function planForStore(store, item, mapping, memberIds) {
  const probe = await probeStore(store);
  const base = {
    id: store.id,
    label: store.label,
    shop: store.shop,
    domain: shopDomain(store.shop),
    configured: store.configured,
    ready: probe.ready,
    error: probe.ready ? null : probe.error,
  };
  if (!probe.ready) {
    return {
      ...base,
      action: 'unavailable',
      actionLabel: 'Needs setup',
      blockers: [probe.error || 'This store is not ready.'],
      product: null,
      collidingProducts: [],
    };
  }

  const shape = variantRowsFor(item, memberIds);
  if (shape.blockers.length > 0 || shape.rows.length === 0) {
    const plan = planStore({ item, mapping, linked: null, skuHits: [], memberIds });
    return {
      ...base,
      action: plan.action,
      actionLabel: actionLabel(plan.action),
      blockers: plan.blockers,
      error: plan.error,
      product: null,
      collidingProducts: [],
      plan,
    };
  }

  const skuHits = await findVariantsBySkus(store, shape.rows.map((row) => row.sku));
  let plan = planStore({ item, mapping, linked: null, skuHits, memberIds });

  if (plan.action === 'create' && item.shopifyProductGid) {
    const linked = await fetchProduct(store, item.shopifyProductGid);
    if (linked) plan = planStore({ item, mapping, linked, skuHits: [], memberIds });
  } else if (plan.action === 'update' && plan.product?.id) {
    const full = await fetchProduct(store, plan.product.id);
    if (full) plan = planStore({ item, mapping, linked: full, skuHits: [], memberIds });
  }

  let definitions = [];
  if (plan.action === 'create' || plan.action === 'update' || plan.action === 'choose') {
    definitions = await listProductMetafieldDefinitions(store);
    plan = withMetafields(plan, item, definitions);
  }

  return {
    ...base,
    action: plan.action,
    actionLabel: actionLabel(plan.action),
    blockers: plan.blockers,
    error: plan.error,
    product: plan.product,
    collidingProducts: plan.collidingProducts,
    definitions,
    plan,
  };
}

function resultFromError(store, err) {
  return {
    id: store.id,
    label: store.label,
    shop: store.shop,
    domain: shopDomain(store.shop),
    status: 'failed',
    action: null,
    actionLabel: 'Failed',
    productId: null,
    adminUrl: null,
    message: err?.message || 'Shopify publish failed.',
  };
}

function outcome(response, created = null) {
  return { response, created };
}

async function executeStore(store, item, planned) {
  if (!planned.ready || !planned.plan) {
    return outcome({
      id: store.id,
      label: store.label,
      shop: store.shop,
      domain: planned.domain,
      status: 'failed',
      action: planned.action,
      actionLabel: planned.actionLabel,
      productId: null,
      adminUrl: null,
      message: planned.error || 'This store is not ready.',
    });
  }
  const plan = planned.plan;
  if (plan.action === 'blocked' || plan.action === 'failed' || plan.action === 'choose') {
    return outcome({
      id: store.id,
      label: store.label,
      shop: store.shop,
      domain: planned.domain,
      status: 'failed',
      action: plan.action,
      actionLabel: actionLabel(plan.action),
      productId: plan.product?.id || null,
      adminUrl: adminProductUrl(store.shop, plan.product?.id),
      message: plan.error || 'This item cannot be published to this store.',
    });
  }

  if (plan.action === 'create') {
    const product = await createDraftProduct(store, {
      fields: productPayload(plan),
      rows: plan.variantsToCreate,
      variantInputs: plan.variantsToCreate.map((row) => variantInput(row, { includePrice: true })),
      imageUrls: imageUrls(item),
    });
    return outcome({
      id: store.id,
      label: store.label,
      shop: store.shop,
      domain: planned.domain,
      status: 'created',
      action: 'create',
      actionLabel: 'Created draft',
      productId: product?.id || null,
      adminUrl: adminProductUrl(store.shop, product?.id),
      message: `Created a draft in ${planned.domain}.${skippedSentence(plan.skippedMetafields)}`,
    }, {
      productId: product?.id || '',
      variants: product?.variants?.nodes || [],
    });
  }

  const productId = plan.product.id;
  await updateProductFields(store, productId, productPayload(plan));
  await deleteProductMetafields(store, productId, plan.metafieldsToClear);
  const full = await fetchProduct(store, productId);
  await addMissingOptionValues(store, full || { id: productId, options: [] }, [
    ...plan.variantsToCreate,
    ...plan.variantsToUpdate,
  ]);
  const createdVariants = await createVariants(
    store,
    productId,
    plan.variantsToCreate.map((row) => variantInput(row, { includePrice: true })),
  );
  await updateVariants(
    store,
    productId,
    plan.variantsToUpdate.map((row) => variantInput(row, { id: row.shopifyVariantId, includePrice: true })),
  );
  const verb = 'Updated';
  return outcome({
    id: store.id,
    label: store.label,
    shop: store.shop,
    domain: planned.domain,
    status: 'updated',
    action: plan.action,
    actionLabel: actionLabel(plan.action),
    productId,
    adminUrl: adminProductUrl(store.shop, productId),
    message: `${verb} the product in ${planned.domain}. Shopify status was left unchanged.${skippedSentence(plan.skippedMetafields)}`,
  }, {
    productId,
    variants: createdVariants,
  });
}

async function loadPublishGroup({ env, itemId }) {
  const item = await loadItem({ env, itemId });
  if (!item || item.deleted === true) return null;
  const loaded = await loadStyleSiblings({ env, styleColor: fieldText(item, STYLE_COLOR_FIELD) });
  return publishGroup(item, loaded.items, { truncated: loaded.truncated });
}

export async function previewItem({ env, itemId, mapping: mappingInput, variantIds }) {
  const item = await loadPublishGroup({ env, itemId });
  if (!item) return null;
  const mapping = normalizeMapping(mappingInput);
  const memberIds = memberIdsFor(item, normalizeVariantIds(variantIds));
  const stores = [];
  for (const store of readStores(env)) {
    try {
      const planned = await planForStore(store, item, mapping, memberIds);
      stores.push({
        id: planned.id,
        label: planned.label,
        shop: planned.shop,
        domain: planned.domain,
        configured: planned.configured,
        ready: planned.ready,
        action: planned.action,
        actionLabel: planned.actionLabel,
        blockers: planned.blockers,
        error: planned.error,
        product: planned.product,
        collidingProducts: planned.collidingProducts,
        createSkus: skuList(planned.plan?.variantsToCreate),
        updateSkus: skuList(planned.plan?.variantsToUpdate),
        productSkus: Array.isArray(planned.plan?.productSkus) ? planned.plan.productSkus : undefined,
      });
    } catch (err) {
      stores.push({
        id: store.id,
        label: store.label,
        shop: store.shop,
        domain: shopDomain(store.shop),
        configured: store.configured,
        ready: false,
        action: 'failed',
        actionLabel: 'Failed',
        blockers: [err?.message || 'Could not check this store.'],
        error: err?.message || 'Could not check this store.',
        product: null,
        collidingProducts: [],
        createSkus: [],
        updateSkus: [],
      });
    }
  }
  return { item, values: previewValues(item, memberIds), stores };
}

function skuList(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => String(row?.sku || '').trim()).filter(Boolean);
}

function chosenTarget(targets, storeId) {
  if (!targets || typeof targets !== 'object') return '';
  const value = targets[storeId];
  return typeof value === 'string' ? value.trim() : '';
}

async function withChoice(store, item, mapping, planned, target, memberIds) {
  const plan = planned.plan;
  if (!plan || plan.action !== 'choose') return planned;

  if (target === 'create') {
    const created = withMetafields(
      planStore({ item, mapping, linked: null, skuHits: [], memberIds }),
      item,
      planned.definitions || [],
    );
    return {
      ...planned,
      action: created.action,
      actionLabel: actionLabel(created.action),
      blockers: created.blockers,
      error: created.error,
      product: created.product,
      plan: created,
    };
  }

  const match = (plan.collidingProducts || []).some((product) => product.id === target);
  if (!match) {
    const error = 'Choose which Shopify product should receive this item, or create a new draft.';
    return {
      ...planned,
      action: 'failed',
      actionLabel: actionLabel('failed'),
      blockers: [error],
      error,
      plan: { ...plan, action: 'failed', blockers: [error], error },
    };
  }

  const full = await fetchProduct(store, target);
  if (!full) {
    const error = 'That Shopify product could not be loaded. Choose it again.';
    return {
      ...planned,
      action: 'failed',
      actionLabel: actionLabel('failed'),
      blockers: [error],
      error,
      plan: { ...plan, action: 'failed', blockers: [error], error },
    };
  }

  const next = withMetafields(
    planStore({ item, mapping, linked: full, skuHits: [], memberIds }),
    item,
    planned.definitions || [],
  );
  return {
    ...planned,
    action: next.action,
    actionLabel: actionLabel(next.action),
    blockers: next.blockers,
    error: next.error,
    product: next.product,
    plan: next,
  };
}

async function rememberShopifyIds({ env, item, outcomes, idStore, memberIds }) {
  const successes = outcomes.filter((entry) => entry.created);
  const requested = typeof idStore === 'string' ? idStore : '';
  const chosenId = successes.some((entry) => entry.response.id === requested)
    ? requested
    : successes.length === 1
      ? successes[0].response.id
      : '';
  const target = successes.find((entry) => entry.response.id === chosenId);
  if (!target) return;
  const pushed = new Set(memberIds);
  const members = (item.members || []).filter((member) => pushed.has(member.id));
  try {
    const decision = suttonIdWrites(members, target.created);
    if (decision.writes.length > 0) await writeShopifyIds({ env, writes: decision.writes });
    target.response.message += suttonIdSentence(decision);
  } catch (err) {
    const detail = err?.message ? ` ${err.message}` : '';
    target.response.message += ` Shopify ids were not saved on the Sutton items.${detail}`;
  }
}

export async function publishItem({ env, itemId, mapping, storeIds, targets, idStore, variantIds }) {
  const item = await loadPublishGroup({ env, itemId });
  if (!item) return null;
  const resolved = normalizeMapping(mapping);
  const memberIds = memberIdsFor(item, normalizeVariantIds(variantIds));
  const wanted = new Set(Array.isArray(storeIds) && storeIds.length > 0 ? storeIds : ['a', 'b']);
  const outcomes = [];
  for (const store of readStores(env)) {
    if (!wanted.has(store.id)) continue;
    try {
      const planned = await planForStore(store, item, resolved, memberIds);
      const chosen = await withChoice(store, item, resolved, planned, chosenTarget(targets, store.id), memberIds);
      outcomes.push(await executeStore(store, item, chosen));
    } catch (err) {
      outcomes.push(outcome(resultFromError(store, err)));
    }
  }
  await rememberShopifyIds({ env, item, outcomes, idStore, memberIds });
  return { results: outcomes.map((entry) => entry.response) };
}
