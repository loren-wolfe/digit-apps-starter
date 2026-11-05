import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  METAFIELD_PAIRS,
  PAGE_SIZE,
  UNMAPPED_SHOPIFY_METAFIELDS,
  descriptionHtml,
  metafieldsFor,
  normalizeShop,
  planStore,
  previewValues,
  productTitle,
  memberIdsFor,
  publishGroup,
  resolveCustomFieldValue,
  shopifyNumericId,
  shopifyProductGid,
  skuSearchQuery,
  suttonIdSentence,
  suttonIdWrites,
} from '../src/backend/mapping.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} ${name}`);
}

function item(overrides = {}) {
  return {
    id: 'item-1',
    name: 'Reef Suit',
    description: 'A suit',
    sku: 'REEF',
    gtin: '111',
    status: 'active',
    itemTypes: ['sell'],
    deleted: false,
    hasVariants: false,
    parent: null,
    category: { value: 'Swim' },
    tags: [{ value: 'summer' }],
    variantTemplate: [],
    variantOptions: [],
    defaultSalesPrice: { costAmount: 80 },
    itemImages: [],
    variants: [],
    ...overrides,
  };
}

function child(id, sku, price, options) {
  return {
    id,
    name: sku,
    sku,
    gtin: '',
    status: 'active',
    deleted: false,
    variantOptions: options,
    defaultSalesPrice: price == null ? null : { costAmount: price },
  };
}

test('page size stays under the Sutton maximum', () => {
  assert.equal(PAGE_SIZE, 50);
  assert.ok(PAGE_SIZE <= 250);
});

test('shop subdomain accepts a bare name or a myshopify host', () => {
  assert.equal(normalizeShop(' my-retail-store '), 'my-retail-store');
  assert.equal(normalizeShop('https://my-b2b-store.myshopify.com/admin'), 'my-b2b-store');
  assert.equal(normalizeShop('not a shop'), null);
});

test('plain description becomes HTML and markup is left as written', () => {
  assert.equal(descriptionHtml('A & B'), '<p>A &amp; B</p>');
  assert.equal(descriptionHtml('<p>Ready</p>'), '<p>Ready</p>');
});

test('sku search quotes values that Shopify would split', () => {
  assert.equal(skuSearchQuery(['REEF', 'A B']), 'sku:REEF OR sku:"A B"');
});

test('standalone item with a price creates one default variant', () => {
  const plan = planStore({ item: item(), mapping: null, linked: null, skuHits: [] });
  assert.equal(plan.action, 'create');
  assert.equal(plan.variantsToCreate.length, 1);
  assert.equal(plan.variantsToCreate[0].optionValues[0].value, 'Default Title');
  assert.equal(plan.productFields.title, 'Reef Suit');
  assert.equal(plan.productFields.productType, 'Swim');
  assert.deepEqual(plan.productFields.tags, ['summer']);
});

test('missing or zero price blocks a create', () => {
  for (const price of [null, 0]) {
    const plan = planStore({
      item: item({ defaultSalesPrice: price == null ? null : { costAmount: price } }),
      mapping: null,
      linked: null,
      skuHits: [],
    });
    assert.equal(plan.action, 'blocked');
    assert.match(plan.error, /price/i);
  }
});

test('empty description, type, and tags are sent as empty values', () => {
  const plan = planStore({
    item: item({ description: '  ', category: null, tags: [] }),
    mapping: { description: 'do_not_send', price: 'do_not_send' },
    linked: null,
    skuHits: [],
  });
  assert.equal(plan.action, 'create');
  assert.equal(plan.productFields.descriptionHtml, '');
  assert.equal(plan.productFields.productType, '');
  assert.deepEqual(plan.productFields.tags, []);
  assert.equal(plan.productFields.title, 'Reef Suit');
});

function sized(id, sku, size, price, extra = {}) {
  const { customFields = [], color = 'Blueberry Latte', ...rest } = extra;
  return item({
    id,
    name: size
      ? `Affogato Scoop Bikini Top - ${size}${color ? ` / ${color}` : ''}`
      : `Affogato Scoop Bikini Top${color ? ` / ${color}` : ''}`,
    sku,
    gtin: '',
    defaultSalesPrice: price == null ? null : { costAmount: price },
    customFields: [
      custom('Size', size),
      custom('Style# + Color', 'D4431-BBLT'),
      ...(color ? [custom('Color', color)] : []),
      ...customFields,
    ],
    ...rest,
  });
}

test('a style group sends the picked size until other sizes are included', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const medium = sized('m', 'REEF-M', 'M', 80);
  const archived = sized('l', 'REEF-L', 'L', 80, { status: 'archived' });
  const group = publishGroup(small, [small, medium, archived]);
  assert.equal(productTitle(small), 'Affogato Scoop Bikini Top');
  const plan = planStore({ item: group, mapping: null, linked: null, skuHits: [] });
  assert.equal(plan.action, 'create');
  assert.equal(plan.productFields.title, 'Affogato Scoop Bikini Top');
  assert.deepEqual(plan.variantsToCreate.map((row) => row.sku), ['REEF-S']);
  assert.deepEqual(plan.variantsToCreate[0].optionValues, [
    { name: 'Size', value: 'S' },
    { name: 'Color', value: 'Blueberry Latte' },
  ]);
  const values = previewValues(group);
  assert.equal(values.styleColor, 'D4431-BBLT');
  assert.equal(values.sku, 'REEF-S');
  assert.equal(values.skuNote, '');
  assert.deepEqual(values.variants.map((row) => [row.sku, row.selected]), [['REEF-S', true], ['REEF-M', false]]);
  assert.deepEqual(memberIdsFor(group, ['m', 'missing']), ['s', 'm']);
  const both = planStore({ item: group, mapping: null, linked: null, skuHits: [], memberIds: ['s', 'm'] });
  assert.deepEqual(both.variantsToCreate.map((row) => row.sku), ['REEF-S', 'REEF-M']);
  assert.deepEqual(both.variantsToCreate.map((row) => row.optionValues), [
    [{ name: 'Size', value: 'S' }, { name: 'Color', value: 'Blueberry Latte' }],
    [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Blueberry Latte' }],
  ]);
  assert.match(previewValues(group, 'm').skuNote, /Per variant/);
});

test('a blank or repeated size blocks only the sizes that are included', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const blank = sized('b', 'REEF-B', '', 80);
  const blankGroup = publishGroup(small, [small, blank]);
  assert.equal(planStore({ item: blankGroup, mapping: null, linked: null, skuHits: [] }).action, 'create');
  assert.match(planStore({ item: blankGroup, mapping: null, linked: null, skuHits: [], memberIds: ['s', 'b'] }).error, /no Size/i);
  assert.equal(previewValues(blankGroup).variants.find((row) => row.itemId === 'b').issue, 'No Size');
  const again = sized('m', 'REEF-M', 'S', 80);
  const repeat = publishGroup(small, [small, again]);
  assert.equal(planStore({ item: repeat, mapping: null, linked: null, skuHits: [] }).action, 'create');
  assert.match(planStore({ item: repeat, mapping: null, linked: null, skuHits: [], memberIds: ['s', 'm'] }).error, /share the size S/i);
});

test('a style name drops the size and color suffix', () => {
  const named = sized('s', 'REEF-S', 'L', 80, { color: 'Pacific Combo', name: 'Ace Bottom - L / Pacific Combo' });
  assert.equal(productTitle(named), 'Ace Bottom');
  const sizeOnly = item({
    name: 'Ace Bottom - L',
    customFields: [custom('Size', 'L')],
  });
  assert.equal(productTitle(sizeOnly), 'Ace Bottom');
});

test('a missing or disagreeing color blocks the sizes that are included', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const blank = sized('b', 'REEF-B', 'M', 80, { color: '' });
  const blankGroup = publishGroup(small, [small, blank]);
  assert.equal(planStore({ item: blankGroup, mapping: null, linked: null, skuHits: [] }).action, 'create');
  assert.match(planStore({ item: blankGroup, mapping: null, linked: null, skuHits: [], memberIds: ['s', 'b'] }).error, /no Color/i);
  assert.equal(previewValues(blankGroup).variants.find((row) => row.itemId === 'b').issue, 'No Color');
  const other = sized('m', 'REEF-M', 'M', 80, { color: 'Poppy White' });
  const mixed = publishGroup(small, [small, other]);
  assert.equal(planStore({ item: mixed, mapping: null, linked: null, skuHits: [] }).action, 'create');
  const blocked = planStore({ item: mixed, mapping: null, linked: null, skuHits: [], memberIds: ['s', 'm'] });
  assert.equal(blocked.action, 'blocked');
  assert.match(blocked.error, /more than one Color/);
  assert.equal(previewValues(mixed).variants.find((row) => row.itemId === 'm').issue, 'Color does not match the colorway');
  assert.equal(previewValues(mixed).variants.find((row) => row.itemId === 's').issue, '');
});

test('a shared Shopify product id is used only when every id agrees', () => {
  const small = sized('s', 'REEF-S', 'S', 80, { customFields: [custom('Shopify Product ID', '8156285239353')] });
  const medium = sized('m', 'REEF-M', 'M', 80);
  assert.equal(shopifyProductGid(publishGroup(small, [small, medium]).members), 'gid://shopify/Product/8156285239353');
  const other = sized('l', 'REEF-L', 'L', 80, { customFields: [custom('Shopify Product ID', '99')] });
  assert.equal(shopifyProductGid([small, other]), null);
  assert.equal(shopifyProductGid([sized('g', 'REEF-G', 'S', 80, { customFields: [custom('Shopify Product ID', 'gid://shopify/Product/42')] })]), 'gid://shopify/Product/42');
});

test('a created product writes numeric ids and leaves a different id alone', () => {
  assert.equal(shopifyNumericId('gid://shopify/Product/8392390606905'), '8392390606905');
  assert.equal(shopifyNumericId('gid://shopify/ProductVariant/45366456778809'), '45366456778809');
  const small = sized('s', 'REEF-S', 'S', 80);
  const medium = sized('m', 'REEF-M', 'M', 80, { customFields: [custom('Shopify Product ID', '99')] });
  const group = publishGroup(small, [small, medium]);
  const decision = suttonIdWrites(group.members, {
    productId: 'gid://shopify/Product/8156285239353',
    variants: [
      { id: 'gid://shopify/ProductVariant/11', sku: 'REEF-S' },
      { id: 'gid://shopify/ProductVariant/22', sku: 'REEF-M' },
    ],
  });
  const smallWrite = decision.writes.find((write) => write.itemId === 's');
  assert.deepEqual(smallWrite.fields, [
    { field: 'product', value: '8156285239353' },
    { field: 'variant', value: '11' },
  ]);
  const mediumWrite = decision.writes.find((write) => write.itemId === 'm');
  assert.deepEqual(mediumWrite.fields, [{ field: 'variant', value: '22' }]);
  assert.equal(decision.kept.length, 1);
  assert.equal(decision.kept[0].itemId, 'm');
  assert.match(suttonIdSentence(decision), /8156285239353/);
  assert.match(suttonIdSentence(decision), /Left the existing Shopify id/);
});

test('an added size fills a blank product id and skips an id that already matches', () => {
  const small = sized('s', 'REEF-S', 'S', 80, {
    customFields: [
      custom('Shopify Product ID', '8156285239353'),
      custom('Shopify Variant ID', '11'),
    ],
  });
  const medium = sized('m', 'REEF-M', 'M', 80);
  const decision = suttonIdWrites(publishGroup(small, [small, medium]).members, {
    productId: 'gid://shopify/Product/8156285239353',
    variants: [{ id: 'gid://shopify/ProductVariant/22', sku: 'REEF-M' }],
  });
  assert.equal(decision.writes.length, 1);
  assert.deepEqual(decision.writes[0].fields, [
    { field: 'product', value: '8156285239353' },
    { field: 'variant', value: '22' },
  ]);
  assert.equal(decision.kept.length, 0);
});

test('inactive and buy-only items are blocked', () => {
  assert.equal(planStore({ item: item({ status: 'draft' }), mapping: null, linked: null, skuHits: [] }).action, 'blocked');
  assert.equal(
    planStore({ item: item({ itemTypes: ['buy'] }), mapping: null, linked: null, skuHits: [] }).action,
    'blocked',
  );
});

test('a linked product updates matching SKUs and adds the missing size', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const medium = sized('m', 'REEF-M', 'M', 90);
  const group = publishGroup(small, [small, medium]);
  const plan = planStore({
    item: group,
    mapping: null,
    linked: {
      id: 'gid://shopify/Product/1',
      title: 'Reef Suit',
      status: 'ACTIVE',
      options: [{ id: 'opt', name: 'Size', optionValues: [{ name: 'S' }] }],
      variants: [{ id: 'gid://shopify/ProductVariant/1', sku: 'REEF-S' }],
    },
    skuHits: [],
    memberIds: ['s', 'm'],
  });
  assert.equal(plan.action, 'update');
  assert.equal(plan.variantsToUpdate.length, 1);
  assert.equal(plan.variantsToUpdate[0].shopifyVariantId, 'gid://shopify/ProductVariant/1');
  assert.deepEqual(plan.variantsToCreate.map((row) => row.sku), ['REEF-M']);
  assert.deepEqual(plan.variantsToCreate[0].optionValues, [
    { name: 'Size', value: 'M' },
    { name: 'Color', value: 'Blueberry Latte' },
  ]);
  assert.deepEqual(plan.productSkus, ['REEF-S']);
});

test('an existing variant with no Sutton price does not block the update', () => {
  const small = sized('s', 'REEF-S', 'S', null);
  const medium = sized('m', 'REEF-M', 'M', 80);
  const plan = planStore({
    item: publishGroup(small, [small, medium]),
    mapping: null,
    linked: {
      id: 'gid://shopify/Product/1',
      title: 'Reef Suit',
      status: 'ACTIVE',
      options: [{ id: 'opt', name: 'Size', optionValues: [{ name: 'S' }, { name: 'M' }] }],
      variants: [{ id: 'v1', sku: 'REEF-S' }, { id: 'v2', sku: 'REEF-M' }],
    },
    skuHits: [],
    memberIds: ['s', 'm'],
  });
  assert.equal(plan.action, 'update');
  assert.equal(plan.variantsToCreate.length, 0);
});

test('a missing size with no price blocks the update', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const medium = sized('m', 'REEF-M', 'M', 0);
  const group = publishGroup(small, [small, medium]);
  const alone = planStore({
    item: group,
    mapping: null,
    linked: {
      id: 'gid://shopify/Product/1',
      title: 'Reef Suit',
      status: 'ACTIVE',
      options: [{ id: 'opt', name: 'Size', optionValues: [{ name: 'S' }, { name: 'M' }] }],
      variants: [{ id: 'v1', sku: 'REEF-S' }],
    },
    skuHits: [],
  });
  assert.equal(alone.action, 'update');
  assert.equal(alone.variantsToCreate.length, 0);
  const plan = planStore({
    item: group,
    mapping: null,
    linked: {
      id: 'gid://shopify/Product/1',
      title: 'Reef Suit',
      status: 'ACTIVE',
      options: [{ id: 'opt', name: 'Size', optionValues: [{ name: 'S' }, { name: 'M' }] }],
      variants: [{ id: 'v1', sku: 'REEF-S' }],
    },
    skuHits: [],
    memberIds: ['s', 'm'],
  });
  assert.equal(plan.action, 'blocked');
  assert.match(plan.error, /REEF-M/);
});

test('SKUs on one product update that product', () => {
  const plan = planStore({
    item: item(),
    mapping: null,
    linked: null,
    skuHits: [
      {
        sku: 'REEF',
        variantId: 'v1',
        productId: 'gid://shopify/Product/9',
        productTitle: 'Old reef',
        productStatus: 'ACTIVE',
        options: [{ id: 'opt', name: 'Title', optionValues: [{ name: 'Default Title' }] }],
      },
    ],
  });
  assert.equal(plan.action, 'update');
  assert.equal(plan.product.id, 'gid://shopify/Product/9');
  assert.equal(plan.variantsToUpdate.length, 1);
  assert.equal(plan.variantsToCreate.length, 0);
});

test('SKUs spread across products ask which product to update', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const medium = sized('m', 'REEF-M', 'M', 80);
  const group = publishGroup(small, [small, medium]);
  const hits = [
    { sku: 'REEF-S', variantId: 'v1', productId: 'p1', productTitle: 'Suit A', productStatus: 'ACTIVE' },
    { sku: 'REEF-M', variantId: 'v2', productId: 'p2', productTitle: 'Suit B', productStatus: 'DRAFT' },
  ];
  const picked = planStore({ item: group, mapping: null, linked: null, skuHits: hits });
  assert.equal(picked.action, 'update');
  assert.equal(picked.product.id, 'p1');
  const plan = planStore({
    item: group,
    mapping: null,
    linked: null,
    skuHits: hits,
    memberIds: ['s', 'm'],
  });
  assert.equal(plan.action, 'choose');
  assert.match(plan.error, /Choose which product/);
  assert.equal(plan.collidingProducts.length, 2);
  assert.equal(plan.collidingProducts[0].title, 'Suit A');
  assert.deepEqual(plan.collidingProducts[0].skus, ['REEF-S']);
  assert.equal(plan.collidingProducts[0].status, 'ACTIVE');
  assert.equal(plan.collidingProducts[1].title, 'Suit B');
  assert.deepEqual(plan.collidingProducts[1].skus, ['REEF-M']);
});

test('a product whose options do not match the Sutton variants is blocked instead of deleting variants', () => {
  const small = sized('s', 'REEF-S', 'S', 80);
  const medium = sized('m', 'REEF-M', 'M', 80);
  const group = publishGroup(small, [small, medium]);
  const alone = planStore({
    item: group,
    mapping: null,
    linked: {
      id: 'p1',
      title: 'Old',
      status: 'ACTIVE',
      options: [{ id: 'opt', name: 'Title', optionValues: [{ name: 'Default Title' }] }],
      variants: [{ id: 'v1', sku: 'REEF-S' }],
    },
    skuHits: [],
  });
  assert.equal(alone.action, 'update');
  const plan = planStore({
    item: group,
    mapping: null,
    linked: {
      id: 'p1',
      title: 'Old',
      status: 'ACTIVE',
      options: [{ id: 'opt', name: 'Title', optionValues: [{ name: 'Default Title' }] }],
      variants: [{ id: 'v1', sku: 'REEF-S' }],
    },
    skuHits: [],
    memberIds: ['s', 'm'],
  });
  assert.equal(plan.action, 'blocked');
  assert.match(plan.error, /options/i);
});

function custom(name, value, type = 'text') {
  if (type === 'singleSelect') {
    return { fieldName: name, fieldType: 'singleSelect', fieldValueOption: { value } };
  }
  if (type === 'number') {
    return { fieldName: name, fieldType: 'number', fieldValueNumber: value };
  }
  return { fieldName: name, fieldType: 'text', fieldValueText: value };
}

function definition(name, type, key) {
  return { name, namespace: 'custom', key, type: { name: type } };
}

test('the page lists the same pairs the publisher writes', () => {
  const source = readFileSync(new URL('../src/frontend/types.ts', import.meta.url), 'utf8');
  for (const pair of METAFIELD_PAIRS) {
    assert.ok(source.includes(`{ sutton: '${pair.sutton}', shopify: '${pair.shopify}' }`));
  }
  for (const name of UNMAPPED_SHOPIFY_METAFIELDS) {
    assert.ok(source.includes(`'${name}'`));
  }
});

test('metafield pairs use the Shopify definition names', () => {
  const bySutton = Object.fromEntries(METAFIELD_PAIRS.map((pair) => [pair.sutton, pair.shopify]));
  assert.equal(bySutton.Color, 'Product Color');
  assert.equal(bySutton.Coverage, 'coverage');
  assert.equal(bySutton['Sub Class'], 'Sub-class');
  assert.equal(bySutton['Sub Class 2'], 'Sub-class 2');
  assert.equal(METAFIELD_PAIRS.length, 12);
  assert.equal(METAFIELD_PAIRS.some((pair) => pair.sutton === 'Shopify Product ID'), false);
  assert.ok(UNMAPPED_SHOPIFY_METAFIELDS.includes('Collection Filter'));
  assert.ok(UNMAPPED_SHOPIFY_METAFIELDS.includes('Disclosures'));
});

test('a parent custom field wins over children', () => {
  const parent = item({
    customFields: [custom('Color', 'Navy')],
    variants: [child('s', 'REEF-S', 80, ['S'])],
  });
  parent.variants[0].customFields = [custom('Color', 'Red')];
  assert.equal(resolveCustomFieldValue(parent, 'Color'), 'Navy');
});

test('a blank parent uses the value only when every active child agrees', () => {
  const agreed = item({
    hasVariants: true,
    customFields: [],
    variants: [child('s', 'REEF-S', 80, ['S']), child('m', 'REEF-M', 80, ['M'])],
  });
  agreed.variants[0].customFields = [custom('Color', 'Navy')];
  agreed.variants[1].customFields = [custom('Color', 'Navy')];
  assert.equal(resolveCustomFieldValue(agreed, 'Color'), 'Navy');

  const split = item({
    hasVariants: true,
    customFields: [],
    variants: [child('s', 'REEF-S', 80, ['S']), child('m', 'REEF-M', 80, ['M'])],
  });
  split.variants[0].customFields = [custom('Color', 'Navy')];
  split.variants[1].customFields = [custom('Color', 'Red')];
  assert.equal(resolveCustomFieldValue(split, 'Color'), '');

  const partial = item({
    hasVariants: true,
    customFields: [],
    variants: [child('s', 'REEF-S', 80, ['S']), child('m', 'REEF-M', 80, ['M'])],
  });
  partial.variants[0].customFields = [custom('Color', 'Navy')];
  partial.variants[1].customFields = [];
  assert.equal(resolveCustomFieldValue(partial, 'Color'), '');
});

test('select and number custom fields become text', () => {
  const parent = item({
    customFields: [custom('Coverage', 'Cheeky', 'singleSelect'), custom('Year', 2026, 'number')],
  });
  assert.equal(resolveCustomFieldValue(parent, 'Coverage'), 'Cheeky');
  assert.equal(resolveCustomFieldValue(parent, 'Year'), '2026');
});

test('metafield inputs format text, numbers, and lists, and clear blanks', () => {
  const parent = item({
    customFields: [
      custom('Coverage', 'Cheeky', 'singleSelect'),
      custom('Year', 2026, 'number'),
      custom('Color', 'Navy'),
      custom('Season', '   '),
    ],
  });
  const built = metafieldsFor(parent, [
    definition('coverage', 'list.single_line_text_field', 'coverage'),
    definition('Year', 'number_integer', 'year'),
    definition('Product Color', 'single_line_text_field', 'product_color'),
    definition('Season', 'single_line_text_field', 'season'),
  ]);
  assert.deepEqual(built.metafields, [
    { namespace: 'custom', key: 'coverage', type: 'list.single_line_text_field', value: '["Cheeky"]' },
    { namespace: 'custom', key: 'year', type: 'number_integer', value: '2026' },
    { namespace: 'custom', key: 'product_color', type: 'single_line_text_field', value: 'Navy' },
  ]);
  assert.deepEqual(built.clear, [{ namespace: 'custom', key: 'season', shopify: 'Season' }]);
  assert.deepEqual(built.skipped, []);
});

test('a blank custom field is cleared and a split across children is left alone', () => {
  const parent = item({
    customFields: [custom('Color', 'Navy')],
  });
  const built = metafieldsFor(parent, [
    definition('coverage', 'single_line_text_field', 'coverage'),
    definition('Product Color', 'single_line_text_field', 'product_color'),
  ]);
  assert.deepEqual(built.metafields.map((field) => field.key), ['product_color']);
  assert.deepEqual(built.clear.map((field) => field.key), ['coverage']);
  assert.deepEqual(built.skipped, []);

  const split = item({
    hasVariants: true,
    customFields: [],
    variants: [child('s', 'REEF-S', 80, ['S']), child('m', 'REEF-M', 80, ['M'])],
  });
  split.variants[0].customFields = [custom('Color', 'Navy')];
  split.variants[1].customFields = [custom('Color', 'Red')];
  const mixed = metafieldsFor(split, [
    definition('Product Color', 'single_line_text_field', 'product_color'),
  ]);
  assert.deepEqual(mixed.metafields, []);
  assert.deepEqual(mixed.clear, []);
  assert.equal(previewValues(split).metafields.find((row) => row.sutton === 'Color').note, 'Variants disagree, so this field is left unchanged.');
});

test('a missing definition or unsupported type is skipped and a blank value is omitted', () => {
  const parent = item({
    customFields: [custom('Color', 'Navy'), custom('Year', 2026, 'number'), custom('Fabrication', '')],
  });
  const built = metafieldsFor(parent, [
    definition('Product Color', 'file_reference', 'product_color'),
  ]);
  assert.deepEqual(built.metafields, []);
  assert.deepEqual(built.skipped, [
    { shopify: 'Year', reason: 'no matching product metafield' },
    { shopify: 'Product Color', reason: 'unsupported type file_reference' },
  ]);
  const preview = previewValues(parent);
  assert.equal(preview.metafields.find((row) => row.sutton === 'Color').shopify, 'Product Color');
  assert.equal(preview.metafields.find((row) => row.sutton === 'Fabrication').value, '');
});

console.log(`\n${passed} tests passed`);
