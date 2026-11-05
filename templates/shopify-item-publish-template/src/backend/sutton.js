import { PAGE_SIZE, SHOPIFY_PRODUCT_ID_FIELD, SHOPIFY_VARIANT_ID_FIELD, STYLE_COLOR_FIELD } from './mapping.js';
import { suttonGraphql } from './suttonGraphql.js';

const SEARCH_QUERY = `
  query SearchSuttonItems($search: String, $first: Int!) {
    items(search: $search, connection: { first: $first }, order: { by: name, direction: asc }) {
      totalCount
      nodes {
        id
        name
        sku
        status
        itemTypes
        deleted
        hasVariants
        parent { id name }
      }
    }
  }
`;

const ITEM_FIELDS = `
  id
  name
  description
  sku
  gtin
  status
  itemTypes
  deleted
  hasVariants
  parent { id name }
  category { id value }
  tags { id value }
  variantTemplate { variantOption optionValues }
  variantOptions
  defaultSalesPrice { costAmount currency { code } }
  itemImages { id url isDefault }
  customFields {
    fieldName
    fieldType
    fieldValueText
    fieldValueOption { value }
    fieldValueNumber
  }
`;

const LOAD_QUERY = `
  query LoadSuttonItem($itemId: ID!) {
    item(itemId: $itemId) {
      ${ITEM_FIELDS}
      variants {
        ${ITEM_FIELDS}
      }
    }
  }
`;

export async function searchItems({ env, search }) {
  const term = typeof search === 'string' ? search.trim() : '';
  const data = await suttonGraphql({
    env,
    query: SEARCH_QUERY,
    variables: { search: term || null, first: PAGE_SIZE },
  });
  const nodes = Array.isArray(data?.items?.nodes) ? data.items.nodes : [];
  return {
    totalCount: data?.items?.totalCount ?? nodes.length,
    items: nodes.filter((item) => item && item.deleted !== true),
  };
}

export async function loadItem({ env, itemId }) {
  const data = await suttonGraphql({
    env,
    query: LOAD_QUERY,
    variables: { itemId },
  });
  return data?.item ?? null;
}

const FIELD_QUERY = `
  query ItemCustomFieldNames($after: String) {
    itemCustomFields(connection: { first: 100, after: $after }) {
      nodes { id name }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function customFieldIds(env, names) {
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const found = {};
  let after = null;
  for (let page = 0; page < 10 && wanted.size > 0; page += 1) {
    const data = await suttonGraphql({ env, query: FIELD_QUERY, variables: { after } });
    const connection = data?.itemCustomFields;
    for (const field of connection?.nodes || []) {
      const key = String(field?.name || '').trim().toLowerCase();
      if (!wanted.has(key) || !field?.id) continue;
      found[wanted.get(key)] = field.id;
      wanted.delete(key);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }
  return found;
}

async function styleColorFieldId(env) {
  const found = await customFieldIds(env, [STYLE_COLOR_FIELD]);
  return found[STYLE_COLOR_FIELD] || null;
}

const WRITE_IDS_MUTATION = `
  mutation WriteShopifyIds($input: UpdateItemsInput!) {
    updateItems(input: $input) {
      results { index error { message code } }
    }
  }
`;

export async function writeShopifyIds({ env, writes }) {
  const changes = Array.isArray(writes) ? writes.filter((write) => write?.itemId && write.fields?.length) : [];
  if (changes.length === 0) return;
  const fieldIds = await customFieldIds(env, [SHOPIFY_PRODUCT_ID_FIELD, SHOPIFY_VARIANT_ID_FIELD]);
  const missing = [SHOPIFY_PRODUCT_ID_FIELD, SHOPIFY_VARIANT_ID_FIELD].filter((name) => !fieldIds[name]);
  if (missing.length > 0) {
    throw new Error(`Sutton is missing the ${missing.join(' and ')} field.`);
  }
  const data = await suttonGraphql({
    env,
    query: WRITE_IDS_MUTATION,
    variables: {
      input: {
        items: changes.map((write) => ({
          itemId: write.itemId,
          customFields: write.fields.map((field) => ({
            fieldId: field.field === 'variant' ? fieldIds[SHOPIFY_VARIANT_ID_FIELD] : fieldIds[SHOPIFY_PRODUCT_ID_FIELD],
            fieldValueText: field.value,
          })),
        })),
      },
    },
  });
  const failed = (data?.updateItems?.results || []).filter((result) => result?.error);
  if (failed.length > 0) {
    throw new Error(failed.map((result) => result.error.message).filter(Boolean).join('; ') || 'Sutton did not save the Shopify ids.');
  }
}

const SIBLINGS_QUERY = `
  query StyleSiblings($fieldId: ID!, $value: String!) {
    items(
      connection: { first: 100 }
      statuses: [active]
      order: { by: name, direction: asc }
      customFields: { filters: [{ fieldId: $fieldId, type: text, value: $value }] }
    ) {
      nodes { ${ITEM_FIELDS} }
      pageInfo { hasNextPage }
    }
  }
`;

export async function loadStyleSiblings({ env, styleColor }) {
  const value = typeof styleColor === 'string' ? styleColor.trim() : '';
  if (!value) return { items: [], truncated: false };
  const fieldId = await styleColorFieldId(env);
  if (!fieldId) return { items: [], truncated: false };
  const data = await suttonGraphql({
    env,
    query: SIBLINGS_QUERY,
    variables: { fieldId, value },
  });
  return {
    items: Array.isArray(data?.items?.nodes) ? data.items.nodes : [],
    truncated: data?.items?.pageInfo?.hasNextPage === true,
  };
}
