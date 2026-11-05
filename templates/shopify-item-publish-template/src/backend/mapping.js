/**
 * Pure publish planning. No network. Shopify calls live in shopify.js / publish.js.
 *
 * Items that share a Style# + Color can become one Shopify product. The picked
 * item is the variant that is sent, with Size and that colorway's Color.
 * Other sizes stay off until they are included. An item with no Style# + Color
 * is one product with a single default variant. Matching uses the SKUs being
 * sent. Existing Shopify variants that are not in that set are never deleted.
 */

export const PAGE_SIZE = 50;
export const MAX_OPTIONS = 3;
export const MAX_VARIANTS = 100;
export const STYLE_COLOR_FIELD = 'Style# + Color';
export const SIZE_FIELD = 'Size';
export const COLOR_FIELD = 'Color';
export const SHOPIFY_PRODUCT_ID_FIELD = 'Shopify Product ID';
export const SHOPIFY_VARIANT_ID_FIELD = 'Shopify Variant ID';

export const DEFAULT_MAPPING = {
  title: 'name',
  description: 'description',
  productType: 'category',
  tags: 'tags',
  sku: 'sku',
  barcode: 'gtin',
  price: 'defaultSalesPrice',
};

const MAPPING_FIELDS = Object.keys(DEFAULT_MAPPING);

export function normalizeMapping(input) {
  const source = input && typeof input === 'object' ? input : {};
  const mapping = { ...DEFAULT_MAPPING };
  for (const field of MAPPING_FIELDS) {
    if (source[field] === DEFAULT_MAPPING[field]) mapping[field] = source[field];
  }
  mapping.title = 'name';
  mapping.sku = 'sku';
  return mapping;
}

export function normalizeShop(raw) {
  if (typeof raw !== 'string') return null;
  let shop = raw.trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, '');
  shop = shop.split('/')[0];
  if (shop.endsWith('.myshopify.com')) shop = shop.slice(0, -'.myshopify.com'.length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(shop)) return null;
  return shop;
}

export function shopDomain(shop) {
  return shop ? `${shop}.myshopify.com` : null;
}

export function adminProductUrl(shop, productGid) {
  if (!shop || !productGid) return null;
  const id = String(productGid).split('/').pop();
  if (!id) return null;
  return `https://admin.shopify.com/store/${shop}/products/${id}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export function descriptionHtml(text) {
  if (text == null) return '';
  const raw = String(text).trim();
  if (!raw) return '';
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return `<p>${escapeHtml(raw)}</p>`;
}

export function priceNumber(cost) {
  if (cost == null || cost.costAmount == null || cost.costAmount === '') return null;
  const amount = Number(cost.costAmount);
  if (!Number.isFinite(amount)) return null;
  return amount;
}

export function priceString(amount) {
  if (amount == null) return null;
  return amount.toFixed(2);
}

export function includesSell(itemTypes) {
  return Array.isArray(itemTypes) && itemTypes.some((type) => String(type).toLowerCase() === 'sell');
}

function isActive(item) {
  return item && item.deleted !== true && String(item.status).toLowerCase() === 'active';
}

function variantRow(source, pairs) {
  return {
    itemId: source.id,
    name: source.name || '',
    optionValues: pairs,
    sku: typeof source.sku === 'string' ? source.sku.trim() : '',
    barcode: typeof source.gtin === 'string' ? source.gtin.trim() : '',
    price: priceNumber(source.defaultSalesPrice),
  };
}

export function fieldText(item, name) {
  return customFieldValue(fieldByName(item, name));
}

export function productTitle(item) {
  const name = String(item?.name || '').trim();
  const size = fieldText(item, SIZE_FIELD);
  const color = fieldText(item, COLOR_FIELD);
  if (!name || !size) return name;
  if (color) {
    const withColor = ` - ${size} / ${color}`;
    if (name.endsWith(withColor)) return name.slice(0, -withColor.length).trim();
  }
  const token = ` - ${size}`;
  const index = name.indexOf(token);
  if (index === -1) return name;
  return `${name.slice(0, index)}${name.slice(index + token.length)}`.replace(/\s{2,}/g, ' ').trim();
}

export function shopifyNumericId(value) {
  const raw = String(value || '').trim().replace(/^gid:\/\/shopify\/(?:Product|ProductVariant)\//i, '');
  return /^\d+$/.test(raw) ? raw : '';
}

/**
 * Fields to write after the chosen store creates a product or adds variants.
 * A blank Shopify id is filled. An id that already differs is left alone.
 */
export function suttonIdWrites(members, { productId, variants } = {}) {
  const nextProductId = shopifyNumericId(productId);
  const variantBySku = new Map();
  for (const variant of Array.isArray(variants) ? variants : []) {
    const sku = String(variant?.sku || '').trim();
    const id = shopifyNumericId(variant?.id);
    if (sku && id) variantBySku.set(sku, id);
  }
  const writes = [];
  const kept = [];
  for (const member of Array.isArray(members) ? members : []) {
    if (!member?.id) continue;
    const fields = [];
    const currentProductId = shopifyNumericId(fieldText(member, SHOPIFY_PRODUCT_ID_FIELD));
    if (nextProductId && !currentProductId) fields.push({ field: 'product', value: nextProductId });
    else if (nextProductId && currentProductId !== nextProductId) {
      kept.push({ itemId: member.id, name: member.name || member.sku || member.id, field: 'product' });
    }
    const nextVariantId = variantBySku.get(String(member.sku || '').trim()) || '';
    const currentVariantId = shopifyNumericId(fieldText(member, SHOPIFY_VARIANT_ID_FIELD));
    if (nextVariantId && !currentVariantId) fields.push({ field: 'variant', value: nextVariantId });
    else if (nextVariantId && currentVariantId !== nextVariantId) {
      kept.push({ itemId: member.id, name: member.name || member.sku || member.id, field: 'variant' });
    }
    if (fields.length > 0) writes.push({ itemId: member.id, name: member.name || member.sku || member.id, fields });
  }
  return { writes, kept };
}

export function suttonIdSentence({ writes, kept } = {}) {
  const changes = Array.isArray(writes) ? writes : [];
  const untouched = Array.isArray(kept) ? kept : [];
  const productIds = [...new Set(changes.flatMap((write) => write.fields.filter((field) => field.field === 'product').map((field) => field.value)))];
  const variantCount = changes.reduce((count, write) => count + write.fields.filter((field) => field.field === 'variant').length, 0);
  const bits = [];
  if (productIds.length > 0 || variantCount > 0) {
    const productText = productIds.length === 1 ? `Shopify product ${productIds[0]}` : 'the Shopify product id';
    const variantText = `${variantCount} variant ${variantCount === 1 ? 'id' : 'ids'}`;
    bits.push(`Saved ${productText} and ${variantText} on the Sutton items.`);
  }
  if (untouched.length > 0) {
    const names = [...new Set(untouched.map((entry) => entry.name || entry.itemId))].join(', ');
    bits.push(`Left the existing Shopify id on ${names}.`);
  }
  return bits.length > 0 ? ` ${bits.join(' ')}` : '';
}

export function shopifyProductGid(members) {
  const ids = [];
  for (const member of Array.isArray(members) ? members : []) {
    const raw = fieldText(member, SHOPIFY_PRODUCT_ID_FIELD).replace(/^gid:\/\/shopify\/Product\//i, '').trim();
    if (!/^\d+$/.test(raw)) continue;
    ids.push(raw);
  }
  const unique = [...new Set(ids)];
  if (unique.length !== 1) return null;
  return `gid://shopify/Product/${unique[0]}`;
}

function sellable(item) {
  return isActive(item) && includesSell(item.itemTypes);
}

/**
 * The picked item plus every active sell sibling that shares its Style# + Color.
 * Custom fields stay on the picked item. Other siblings sit on `variants` so a
 * blank product field is used only when they all agree.
 */
export function publishGroup(picked, siblings, { truncated = false } = {}) {
  if (!picked) return null;
  const styleColor = fieldText(picked, STYLE_COLOR_FIELD);
  const members = [];
  const seen = new Set();
  const add = (source) => {
    if (!source?.id || seen.has(source.id) || !sellable(source)) return;
    if (styleColor && fieldText(source, STYLE_COLOR_FIELD) !== styleColor) return;
    seen.add(source.id);
    members.push(source);
  };
  add(picked);
  if (styleColor) {
    for (const sibling of Array.isArray(siblings) ? siblings : []) add(sibling);
  }
  return {
    ...picked,
    name: productTitle(picked),
    styleColor,
    shopifyProductGid: shopifyProductGid(members),
    memberOverflow: truncated === true,
    members,
    variants: members.filter((member) => member.id !== picked.id),
  };
}

export function normalizeVariantIds(value) {
  if (value == null) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw
    .filter((id) => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean);
}

function sellableMembers(item) {
  const members = Array.isArray(item?.members) && item.members.length > 0 ? item.members : [item];
  return members.filter((member) => sellable(member));
}

/**
 * The picked item, plus any requested siblings that belong to the group.
 * Omitting the request sends only the picked item.
 */
export function memberIdsFor(item, requested) {
  const members = sellableMembers(item);
  const allowed = new Set(members.map((member) => member.id).filter(Boolean));
  const picked = allowed.has(item?.id) ? item.id : members[0]?.id;
  const chosen = new Set(picked ? [picked] : []);
  for (const id of normalizeVariantIds(requested) || []) {
    if (allowed.has(id)) chosen.add(id);
  }
  return [...chosen];
}

function isStyleGroup(item) {
  return Boolean(String(item?.styleColor || '').trim());
}

/**
 * Variants that will be sent. A style group uses Size and Color even when one
 * size is selected. Every size in the colorway uses the same Color. An item
 * with no Style# + Color uses the default variant.
 * Returns { rows, blockers }.
 */
export function variantRowsFor(item, memberIds) {
  const blockers = [];
  if (!item) return { rows: [], blockers: ['Choose a Sutton item.'] };
  if (item.deleted === true) return { rows: [], blockers: ['This item is deleted in Sutton.'] };
  if (!isActive(item)) return { rows: [], blockers: ['Only active items can be published.'] };
  if (!includesSell(item.itemTypes)) {
    return { rows: [], blockers: ['Only items whose type includes sell can be published.'] };
  }

  const chosen = new Set(memberIdsFor(item, memberIds));
  const active = sellableMembers(item).filter((member) => chosen.has(member.id));
  if (active.length === 0) return { rows: [], blockers: ['Only active items can be published.'] };
  if (active.length > MAX_VARIANTS) {
    return { rows: [], blockers: [`Shopify accepts at most ${MAX_VARIANTS} variants on one product.`] };
  }
  if (!isStyleGroup(item)) {
    return { rows: [variantRow(active[0], [{ name: 'Title', value: 'Default Title' }])], blockers };
  }

  const rows = [];
  const seenSizes = new Set();
  const seenSkus = new Set();
  const colors = [];
  for (const member of active) {
    const size = fieldText(member, SIZE_FIELD);
    const color = fieldText(member, COLOR_FIELD);
    const label = member.sku || member.name || 'A variant';
    if (!size) {
      blockers.push(`${label} has no Size.`);
      continue;
    }
    if (!color) {
      blockers.push(`${label} has no Color.`);
      continue;
    }
    const sizeKey = size.toLowerCase();
    if (seenSizes.has(sizeKey)) {
      blockers.push(`Two variants share the size ${size}.`);
      continue;
    }
    seenSizes.add(sizeKey);
    if (!colors.includes(color)) colors.push(color);
    const row = variantRow(member, [
      { name: SIZE_FIELD, value: size },
      { name: COLOR_FIELD, value: color },
    ]);
    if (row.sku) {
      const key = row.sku.toLowerCase();
      if (seenSkus.has(key)) blockers.push(`SKU ${row.sku} is used by more than one variant.`);
      seenSkus.add(key);
    }
    rows.push(row);
  }
  if (colors.length > 1) {
    blockers.push(`These sizes use more than one Color (${colors.join(', ')}).`);
  }
  return { rows, blockers };
}

function productFields(item) {
  return {
    title: item.name || '',
    descriptionHtml: descriptionHtml(item.description),
    productType: item.category?.value || '',
    tags: (Array.isArray(item.tags) ? item.tags : [])
      .map((tag) => tag?.value)
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim()),
  };
}

function sameSku(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function rowBlockers(row, { creating }) {
  const blockers = [];
  const label = row.sku || row.name || 'A variant';
  if (!row.sku) blockers.push(`${label} has no SKU.`);
  if (creating && !(row.price != null && row.price > 0)) {
    blockers.push(`${label} needs a Sutton default sales price greater than zero before it can be created.`);
  }
  return blockers;
}

/**
 * Decide what one store should do with this item.
 *
 * linked: Shopify product to update, or null when the plan should match by SKU.
 * skuHits: variants in the store whose SKU matches a Sutton variant.
 *   [{ sku, productId, productTitle, productHandle, productStatus, variantId }]
 */
export function planStore({ item, linked, skuHits, memberIds }) {
  const { rows, blockers: shapeBlockers } = variantRowsFor(item, memberIds);
  const blockers = [...shapeBlockers];
  const hits = Array.isArray(skuHits) ? skuHits : [];

  if (blockers.length > 0 || rows.length === 0) {
    return {
      action: 'blocked',
      blockers,
      error: blockers[0] || 'This item cannot be published.',
      product: linked ? productSummary(linked) : null,
      collidingProducts: [],
      variantsToCreate: [],
      variantsToUpdate: [],
      productFields: {},
      rows,
    };
  }

  const fields = productFields(item);
  if (!fields.title) blockers.push('Product title is required to create a Shopify product.');

  if (linked?.id) {
    return finishLinked({
      action: 'update',
      item,
      rows,
      blockers,
      fields,
      product: linked,
    });
  }

  const byProduct = new Map();
  for (const hit of hits) {
    if (!hit?.productId) continue;
    const matches = rows.some((row) => row.sku && sameSku(row.sku, hit.sku));
    if (!matches) continue;
    if (!byProduct.has(hit.productId)) {
      byProduct.set(hit.productId, {
        id: hit.productId,
        title: hit.productTitle || 'Untitled product',
        handle: hit.productHandle || '',
        status: hit.productStatus || null,
        variants: [],
        options: hit.options || [],
      });
    }
    byProduct.get(hit.productId).variants.push({ id: hit.variantId, sku: hit.sku });
  }

  if (byProduct.size > 1) {
    const collidingProducts = [...byProduct.values()].map(collisionSummary);
    const error = 'These SKUs are already on more than one Shopify product. Choose which product to update, or create a new draft.';
    return {
      action: 'choose',
      blockers: [error],
      error,
      product: null,
      collidingProducts,
      variantsToCreate: [],
      variantsToUpdate: [],
      productFields: fields,
      rows,
    };
  }

  if (byProduct.size === 1) {
    const product = [...byProduct.values()][0];
    return finishLinked({
      action: 'update',
      item,
      rows,
      blockers,
      fields,
      product,
    });
  }

  for (const row of rows) blockers.push(...rowBlockers(row, { creating: true }));
  if (blockers.length > 0) {
    return {
      action: 'blocked',
      blockers,
      error: blockers[0],
      product: null,
      collidingProducts: [],
      variantsToCreate: [],
      variantsToUpdate: [],
      productFields: fields,
      rows,
    };
  }

  return {
    action: 'create',
    blockers: [],
    error: null,
    product: null,
    collidingProducts: [],
    variantsToCreate: rows,
    variantsToUpdate: [],
    productFields: fields,
    rows,
  };
}

function productSummary(product) {
  return {
    id: product.id,
    title: product.title || 'Untitled product',
    handle: product.handle || '',
    status: product.status || null,
  };
}

function collisionSummary(product) {
  const skus = [];
  for (const variant of product.variants || []) {
    const sku = String(variant.sku || '').trim();
    if (!sku || skus.some((entry) => entry.toLowerCase() === sku.toLowerCase())) continue;
    skus.push(sku);
  }
  return { ...productSummary(product), skus };
}

function linkedProductSkus(product) {
  const existing = Array.isArray(product?.variants) ? product.variants : [];
  return existing.map((variant) => String(variant.sku || '').trim()).filter(Boolean);
}

function finishLinked({ action, rows, blockers, fields, product }) {
  const existing = Array.isArray(product.variants) ? product.variants : [];
  const productSkus = linkedProductSkus(product);
  const variantsToUpdate = [];
  const variantsToCreate = [];
  for (const row of rows) {
    const match = row.sku
      ? existing.find((variant) => sameSku(variant.sku, row.sku))
      : null;
    if (match) variantsToUpdate.push({ ...row, shopifyVariantId: match.id });
    else variantsToCreate.push(row);
  }
  for (const row of variantsToCreate) blockers.push(...rowBlockers(row, { creating: true }));
  if (!rowHasOptions(product, variantsToCreate)) {
    blockers.push(
      `Shopify product "${product.title || 'Untitled product'}" does not have the options these variants need, so the missing sizes cannot be added.`,
    );
  }
  if (blockers.length > 0) {
    return {
      action: 'blocked',
      blockers,
      error: blockers[0],
      product: productSummary(product),
      collidingProducts: [],
      variantsToCreate: [],
      variantsToUpdate: [],
      productSkus,
      productFields: fields,
      rows,
    };
  }
  return {
    action,
    blockers: [],
    error: null,
    product: productSummary(product),
    collidingProducts: [],
    variantsToCreate,
    variantsToUpdate,
    productSkus,
    productFields: fields,
    rows,
  };
}

function rowHasOptions(product, rows) {
  if (rows.length === 0) return true;
  const options = Array.isArray(product.options) ? product.options : [];
  if (options.length === 0) return true;
  const names = new Set(options.map((option) => String(option.name || '').toLowerCase()));
  return rows.every((row) =>
    row.optionValues.every((pair) => {
      const name = String(pair.name || '').toLowerCase();
      if (names.has(name)) return true;
      return name === 'color' && names.has('size');
    }),
  );
}

/**
 * Sutton item custom field → Shopify product metafield definition name.
 * Matching is the definition's name, including the store's hyphenation and case.
 */
export const METAFIELD_PAIRS = [
  { sutton: 'Top Style', shopify: 'Top Style' },
  { sutton: 'Coverage', shopify: 'coverage' },
  { sutton: 'Sub Class 2', shopify: 'Sub-class 2' },
  { sutton: 'Department', shopify: 'Department' },
  { sutton: 'Collection', shopify: 'Collection' },
  { sutton: 'Style Type', shopify: 'Style Type' },
  { sutton: 'Sub Class', shopify: 'Sub-class' },
  { sutton: 'Year', shopify: 'Year' },
  { sutton: 'Season', shopify: 'Season' },
  { sutton: 'Fabrication', shopify: 'Fabrication' },
  { sutton: 'Color Code', shopify: 'Color Code' },
  { sutton: COLOR_FIELD, shopify: 'Product Color' },
];

export const UNMAPPED_SHOPIFY_METAFIELDS = [
  'Collection Filter',
  'Bottom Sub Class 2',
  'One Piece Coverage',
  'Image Swatch',
  'MSRP',
  'Fabric and Description',
  'Class',
  'Disclosures',
];

const WRITABLE_METAFIELD_TYPES = new Set([
  'single_line_text_field',
  'multi_line_text_field',
  'number_integer',
  'number_decimal',
  'list.single_line_text_field',
]);

function sameLabel(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function activeChildren(item) {
  return (Array.isArray(item?.variants) ? item.variants : []).filter(
    (child) => child && child.id !== item.id && child.deleted !== true && isActive(child),
  );
}

function customFieldValue(field) {
  if (!field) return '';
  const type = String(field.fieldType || '');
  if (type === 'singleSelect' || type === 'multiSelect') {
    const selected = field.fieldValueOption?.value;
    if (typeof selected === 'string' && selected.trim()) return selected.trim();
    return '';
  }
  if (type === 'number') {
    if (field.fieldValueNumber == null || field.fieldValueNumber === '') return '';
    const amount = Number(field.fieldValueNumber);
    return Number.isFinite(amount) ? String(amount) : '';
  }
  if (typeof field.fieldValueText === 'string' && field.fieldValueText.trim()) return field.fieldValueText.trim();
  if (field.fieldValueNumber != null && field.fieldValueNumber !== '') {
    const amount = Number(field.fieldValueNumber);
    if (Number.isFinite(amount)) return String(amount);
  }
  const selected = field.fieldValueOption?.value;
  if (typeof selected === 'string' && selected.trim()) return selected.trim();
  return '';
}

function fieldByName(owner, name) {
  const fields = Array.isArray(owner?.customFields) ? owner.customFields : [];
  return fields.find((field) => sameLabel(field?.fieldName, name)) || null;
}

/**
 * Parent value wins. A blank parent uses the child value only when every
 * active child has that same non-blank value. status is `blank` when nothing
 * was entered, and `mixed` when active children do not agree.
 */
export function resolveCustomField(item, name) {
  if (!item) return { value: '', status: 'blank' };
  const parentValue = customFieldValue(fieldByName(item, name));
  if (parentValue) return { value: parentValue, status: 'value' };
  const children = activeChildren(item);
  if (children.length === 0) return { value: '', status: 'blank' };
  const values = children.map((child) => customFieldValue(fieldByName(child, name)));
  if (values.every((value) => !value)) return { value: '', status: 'blank' };
  const first = values[0];
  if (first && values.every((value) => value === first)) return { value: first, status: 'value' };
  return { value: '', status: 'mixed' };
}

export function resolveCustomFieldValue(item, name) {
  return resolveCustomField(item, name).value;
}

export function metafieldPreview(item) {
  return METAFIELD_PAIRS.map((pair) => {
    const resolved = resolveCustomField(item, pair.sutton);
    return {
      sutton: pair.sutton,
      shopify: pair.shopify,
      value: resolved.value,
      note: resolved.status === 'mixed' ? 'Variants disagree, so this field is left unchanged.' : '',
    };
  });
}

function definitionTypeName(definition) {
  const type = definition?.type;
  if (typeof type === 'string') return type;
  return typeof type?.name === 'string' ? type.name : '';
}

function formatMetafieldValue(raw, type) {
  if (type === 'single_line_text_field' || type === 'multi_line_text_field') return raw;
  if (type === 'list.single_line_text_field') return JSON.stringify([raw]);
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return null;
  if (type === 'number_integer') {
    if (!Number.isInteger(amount)) return null;
    return String(amount);
  }
  if (type === 'number_decimal') return String(amount);
  return null;
}

/**
 * definitions: Shopify metafield definitions [{ name, namespace, key, type: { name } }].
 * A blank Sutton value is listed in `clear` so the publish can delete it.
 * Children that disagree are left unchanged. A value with no definition, or a
 * type this app cannot write, is listed in skipped and is not sent.
 */
export function metafieldsFor(item, definitions) {
  const defs = Array.isArray(definitions) ? definitions : [];
  const metafields = [];
  const clear = [];
  const skipped = [];
  for (const pair of METAFIELD_PAIRS) {
    const resolved = resolveCustomField(item, pair.sutton);
    const definition = defs.find((entry) => sameLabel(entry?.name, pair.shopify));
    if (resolved.status === 'mixed') continue;
    if (resolved.status === 'blank') {
      if (definition?.namespace && definition?.key) {
        clear.push({ namespace: definition.namespace, key: definition.key, shopify: pair.shopify });
      }
      continue;
    }
    const type = definitionTypeName(definition);
    if (!definition?.namespace || !definition?.key || !type) {
      skipped.push({ shopify: pair.shopify, reason: 'no matching product metafield' });
      continue;
    }
    if (!WRITABLE_METAFIELD_TYPES.has(type)) {
      skipped.push({ shopify: pair.shopify, reason: `unsupported type ${type}` });
      continue;
    }
    const formatted = formatMetafieldValue(resolved.value, type);
    if (formatted == null) {
      skipped.push({ shopify: pair.shopify, reason: `unsupported type ${type}` });
      continue;
    }
    metafields.push({
      namespace: definition.namespace,
      key: definition.key,
      type,
      value: formatted,
    });
  }
  return { metafields, clear, skipped };
}

function listedVariants(item) {
  const members = sellableMembers(item);
  if (!isStyleGroup(item)) {
    const source = members[0] || item;
    return [previewVariant(variantRow(source, [{ name: 'Title', value: 'Default Title' }]), '')];
  }
  const seenSizes = new Set();
  const pickedColor = fieldText(item, COLOR_FIELD);
  return members.map((member) => {
    const size = fieldText(member, SIZE_FIELD);
    const color = fieldText(member, COLOR_FIELD);
    const pairs = [];
    if (size) pairs.push({ name: SIZE_FIELD, value: size });
    if (color) pairs.push({ name: COLOR_FIELD, value: color });
    const row = variantRow(member, pairs);
    let issue = '';
    if (!size) issue = 'No Size';
    else if (seenSizes.has(size.toLowerCase())) issue = `Size ${size} is already used`;
    else seenSizes.add(size.toLowerCase());
    if (!issue && !color) issue = 'No Color';
    if (!issue && pickedColor && color !== pickedColor) issue = 'Color does not match the colorway';
    if (!issue && !row.sku) issue = 'No SKU';
    return previewVariant(row, issue);
  });
}

function previewVariant(row, issue) {
  return {
    ...row,
    price: row.price,
    priceLabel: row.price != null ? priceString(row.price) : '',
    optionsLabel: row.optionValues.map((pair) => pair.value).filter(Boolean).join(' / '),
    issue,
  };
}

export function previewValues(item, memberIds) {
  if (!item) return null;
  const selected = new Set(memberIdsFor(item, memberIds));
  const { rows } = variantRowsFor(item, [...selected]);
  const single = rows.length === 1 ? rows[0] : null;
  return {
    title: item.name || '',
    description: item.description || '',
    productType: item.category?.value || '',
    tags: (item.tags || []).map((tag) => tag.value).filter(Boolean),
    sku: single ? single.sku : '',
    skuNote: rows.length > 1 ? 'Per variant — see the list below.' : '',
    barcode: single ? single.barcode : '',
    barcodeNote: rows.length > 1 ? 'Per variant — see the list below.' : '',
    price: single && single.price != null ? priceString(single.price) : '',
    priceNote: rows.length > 1 ? 'Per variant — see the list below.' : '',
    variants: listedVariants(item).map((row) => ({ ...row, selected: selected.has(row.itemId) })),
    styleColor: item.styleColor || '',
    memberOverflow: item.memberOverflow === true,
    metafields: metafieldPreview(item),
  };
}

export function imageUrls(item) {
  const images = Array.isArray(item?.itemImages) ? item.itemImages : [];
  return images
    .map((image) => image?.url)
    .filter((url) => typeof url === 'string' && /^https:\/\//i.test(url.trim()))
    .map((url) => url.trim());
}

export function skuSearchQuery(skus) {
  return skus
    .map((sku) => String(sku || '').trim())
    .filter(Boolean)
    .map((sku) => `sku:${quoteSku(sku)}`)
    .join(' OR ');
}

function quoteSku(sku) {
  if (/^[A-Za-z0-9._-]+$/.test(sku)) return sku;
  return `"${sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function actionLabel(action) {
  if (action === 'create') return 'Create draft';
  if (action === 'update') return 'Update';
  if (action === 'choose') return 'Choose a product';
  if (action === 'blocked') return 'Blocked';
  if (action === 'failed') return 'Needs attention';
  return 'Ready';
}
