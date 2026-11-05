import { normalizeShop, shopDomain, skuSearchQuery } from './mapping.js';

export const API_VERSION = '2026-04';

export const STORE_SPECS = [
  {
    id: 'a',
    label: 'Store A',
    shopKey: 'SHOPIFY_STORE_A_SHOP',
    idKey: 'SHOPIFY_STORE_A_CLIENT_ID',
    secretKey: 'SHOPIFY_STORE_A_CLIENT_SECRET',
  },
  {
    id: 'b',
    label: 'Store B',
    shopKey: 'SHOPIFY_STORE_B_SHOP',
    idKey: 'SHOPIFY_STORE_B_CLIENT_ID',
    secretKey: 'SHOPIFY_STORE_B_CLIENT_SECRET',
  },
];

const tokens = new Map();

export function readStore(env, spec) {
  const shop = normalizeShop(typeof env?.[spec.shopKey] === 'string' ? env[spec.shopKey] : '');
  const clientId = typeof env?.[spec.idKey] === 'string' ? env[spec.idKey].trim() : '';
  const clientSecret = typeof env?.[spec.secretKey] === 'string' ? env[spec.secretKey].trim() : '';
  return {
    ...spec,
    shop,
    clientId,
    clientSecret,
    configured: Boolean(shop && clientId && clientSecret),
  };
}

export function readStores(env) {
  return STORE_SPECS.map((spec) => readStore(env, spec));
}

function tokenErrorMessage(detail) {
  const text = String(detail || 'Shopify rejected the client credentials.');
  if (/shop_not_permitted/i.test(text)) {
    return 'Shopify refused the token exchange (shop_not_permitted). The Dev Dashboard app and this store must be in the same Shopify organization, and the app must be installed on the store.';
  }
  return `Shopify token exchange failed: ${text}`;
}

export async function getAccessToken(store) {
  const cacheKey = `${store.shop}:${store.clientId}`;
  const cached = tokens.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  let response;
  try {
    response = await fetch(`https://${store.shop}.myshopify.com/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: store.clientId,
        client_secret: store.clientSecret,
      }),
    });
  } catch {
    const err = new Error(`Could not reach Shopify to exchange credentials for ${shopDomain(store.shop)}.`);
    err.code = 'SHOPIFY_AUTH';
    throw err;
  }

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok || !body?.access_token) {
    const detail = body?.error_description || body?.error || text || `HTTP ${response.status}`;
    const err = new Error(tokenErrorMessage(detail));
    err.code = 'SHOPIFY_AUTH';
    throw err;
  }
  const expiresIn = Number(body.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86399;
  tokens.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + ttl * 1000 });
  return body.access_token;
}

export async function shopifyGraphql(store, query, variables) {
  const token = await getAccessToken(store);
  let response;
  try {
    response = await fetch(`https://${store.shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    const err = new Error(`Could not reach the Shopify Admin API for ${shopDomain(store.shop)}.`);
    err.code = 'SHOPIFY_API';
    throw err;
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.errors?.[0]?.message || `Shopify HTTP ${response.status}`;
    const err = new Error(message);
    err.code = 'SHOPIFY_API';
    throw err;
  }
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const err = new Error(payload.errors.map((entry) => entry.message).filter(Boolean).join('; '));
    err.code = 'SHOPIFY_API';
    err.graphqlErrors = payload.errors;
    throw err;
  }
  return payload?.data ?? null;
}

function userErrorsOf(payload, key) {
  const errors = payload?.[key]?.userErrors;
  return Array.isArray(errors) ? errors : [];
}

function throwUserErrors(payload, key) {
  const errors = userErrorsOf(payload, key);
  if (errors.length === 0) return;
  const message = errors
    .map((entry) => entry?.message)
    .filter(Boolean)
    .join('; ');
  const err = new Error(message || 'Shopify rejected the change.');
  err.code = 'SHOPIFY_API';
  err.userErrors = errors;
  throw err;
}

const PRODUCT_FIELDS = `
  id
  title
  handle
  status
  options { id name optionValues { name } }
  variants(first: 100) { nodes { id sku } }
`;

export async function probeStore(store) {
  if (!store.configured) {
    return { ready: false, error: 'Add this store’s shop, client ID, and client secret.', name: null };
  }
  try {
    const data = await shopifyGraphql(store, '{ shop { name myshopifyDomain } }');
    return { ready: true, error: null, name: data?.shop?.name || null, domain: data?.shop?.myshopifyDomain || null };
  } catch (err) {
    return { ready: false, error: err?.message || 'Shopify credentials were rejected.', name: null };
  }
}

function normalizeProduct(product) {
  if (!product?.id) return null;
  const variants = product.variants?.nodes || product.variants || [];
  return {
    id: product.id,
    title: product.title || '',
    handle: product.handle || '',
    status: product.status || null,
    options: Array.isArray(product.options) ? product.options : [],
    variants: variants.map((variant) => ({ id: variant.id, sku: variant.sku || '' })),
  };
}

export async function fetchProduct(store, productId) {
  const data = await shopifyGraphql(
    store,
    `query ProductForPublish($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
    { id: productId },
  );
  return normalizeProduct(data?.product);
}

export async function findVariantsBySkus(store, skus) {
  const clean = [...new Set(skus.map((sku) => String(sku || '').trim()).filter(Boolean))];
  const hits = [];
  for (let index = 0; index < clean.length; index += 20) {
    const query = skuSearchQuery(clean.slice(index, index + 20));
    if (!query) continue;
    const data = await shopifyGraphql(
      store,
      `query VariantsBySku($query: String!) {
        productVariants(first: 50, query: $query) {
          nodes {
            id
            sku
            product { id title handle status }
          }
        }
      }`,
      { query },
    );
    for (const node of data?.productVariants?.nodes || []) {
      if (!node?.product?.id) continue;
      hits.push({
        sku: node.sku || '',
        variantId: node.id,
        productId: node.product.id,
        productTitle: node.product.title,
        productHandle: node.product.handle,
        productStatus: node.product.status,
      });
    }
  }
  return hits;
}

export async function listProductMetafieldDefinitions(store) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await shopifyGraphql(
      store,
      `query ProductMetafieldDefinitions($after: String) {
        metafieldDefinitions(first: 100, ownerType: PRODUCT, after: $after) {
          nodes { name namespace key type { name } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    const connection = data?.metafieldDefinitions;
    for (const node of connection?.nodes || []) nodes.push(node);
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }
  return nodes;
}

export async function createDraftProduct(store, { fields, rows, variantInputs, imageUrls }) {
  const input = {
    status: 'DRAFT',
    productOptions: productOptionsFromRows(rows),
    variants: variantInputs,
  };
  if (fields.title != null) input.title = fields.title;
  if (fields.descriptionHtml != null) input.descriptionHtml = fields.descriptionHtml;
  if (fields.productType != null) input.productType = fields.productType;
  if (fields.tags != null) input.tags = fields.tags;
  if (Array.isArray(fields.metafields) && fields.metafields.length > 0) input.metafields = fields.metafields;
  if (imageUrls.length > 0) {
    input.files = imageUrls.map((url) => ({ originalSource: url, contentType: 'IMAGE' }));
  }
  const data = await shopifyGraphql(
    store,
    `mutation CreateSuttonProduct($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product { id handle title status variants(first: 100) { nodes { id sku } } }
        userErrors { field message code }
      }
    }`,
    { input },
  );
  throwUserErrors(data, 'productSet');
  return data?.productSet?.product ?? null;
}

export async function updateProductFields(store, productId, fields) {
  const input = { id: productId };
  if (fields.title != null) input.title = fields.title;
  if (fields.descriptionHtml != null) input.descriptionHtml = fields.descriptionHtml;
  if (fields.productType != null) input.productType = fields.productType;
  if (fields.tags != null) input.tags = fields.tags;
  if (Array.isArray(fields.metafields) && fields.metafields.length > 0) input.metafields = fields.metafields;
  if (Object.keys(input).length === 1) return;
  const data = await shopifyGraphql(
    store,
    `mutation UpdateSuttonProduct($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id handle status }
        userErrors { field message }
      }
    }`,
    { input },
  );
  throwUserErrors(data, 'productUpdate');
}

export async function deleteProductMetafields(store, productId, identifiers) {
  const wanted = (Array.isArray(identifiers) ? identifiers : []).filter((entry) => entry?.namespace && entry?.key);
  if (!productId || wanted.length === 0) return;
  const present = new Set();
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await shopifyGraphql(
      store,
      `query ProductMetafields($id: ID!, $after: String) {
        product(id: $id) {
          metafields(first: 100, after: $after) {
            nodes { namespace key }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: productId, after },
    );
    const connection = data?.product?.metafields;
    for (const node of connection?.nodes || []) {
      if (node?.namespace && node?.key) present.add(`${node.namespace}.${node.key}`);
    }
    if (!connection?.pageInfo?.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) break;
  }
  const metafields = wanted
    .filter((entry) => present.has(`${entry.namespace}.${entry.key}`))
    .map((entry) => ({ ownerId: productId, namespace: entry.namespace, key: entry.key }));
  if (metafields.length === 0) return;
  const data = await shopifyGraphql(
    store,
    `mutation DeleteSuttonMetafields($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields { key namespace ownerId }
        userErrors { field message }
      }
    }`,
    { metafields },
  );
  throwUserErrors(data, 'metafieldsDelete');
}

function optionName(value) {
  return String(value || '').toLowerCase();
}

async function ensureColorOption(store, product, rows) {
  const options = Array.isArray(product?.options) ? product.options : [];
  const hasSize = options.some((option) => optionName(option.name) === 'size');
  const hasColor = options.some((option) => optionName(option.name) === 'color');
  if (!product?.id || !hasSize || hasColor) return;
  const values = [];
  for (const row of rows || []) {
    for (const pair of row.optionValues || []) {
      if (optionName(pair.name) !== 'color') continue;
      const value = String(pair.value || '');
      if (!value || values.includes(value)) continue;
      values.push(value);
    }
  }
  if (values.length === 0) return;
  const data = await shopifyGraphql(
    store,
    `mutation AddColorOption($productId: ID!, $options: [OptionCreateInput!]!, $variantStrategy: ProductOptionCreateVariantStrategy) {
      productOptionsCreate(productId: $productId, options: $options, variantStrategy: $variantStrategy) {
        userErrors { field message code }
        product { id }
      }
    }`,
    {
      productId: product.id,
      options: [{ name: 'Color', values: values.map((name) => ({ name })) }],
      variantStrategy: 'LEAVE_AS_IS',
    },
  );
  throwUserErrors(data, 'productOptionsCreate');
}

export async function addMissingOptionValues(store, product, rows) {
  await ensureColorOption(store, product, rows);
  const options = Array.isArray(product?.options) ? product.options : [];
  for (const option of options) {
    if (!option?.id) continue;
    const have = new Set(
      (option.optionValues || []).map((value) => String(value?.name || '').toLowerCase()),
    );
    const needed = [];
    for (const row of rows) {
      for (const pair of row.optionValues || []) {
        if (String(pair.name || '').toLowerCase() !== String(option.name || '').toLowerCase()) continue;
        const value = String(pair.value || '');
        if (!value || have.has(value.toLowerCase()) || needed.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
          continue;
        }
        needed.push(value);
      }
    }
    if (needed.length === 0) continue;
    const data = await shopifyGraphql(
      store,
      `mutation AddOptionValues($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
        productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
          userErrors { field message code }
        }
      }`,
      {
        productId: product.id,
        option: { id: option.id },
        optionValuesToAdd: needed.map((name) => ({ name })),
      },
    );
    throwUserErrors(data, 'productOptionUpdate');
  }
}

export async function createVariants(store, productId, variants) {
  if (variants.length === 0) return [];
  const data = await shopifyGraphql(
    store,
    `mutation AddSuttonVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkCreate(productId: $productId, variants: $variants) {
        productVariants { id sku }
        userErrors { field message }
      }
    }`,
    { productId, variants },
  );
  throwUserErrors(data, 'productVariantsBulkCreate');
  return data?.productVariantsBulkCreate?.productVariants || [];
}

export async function updateVariants(store, productId, variants) {
  if (variants.length === 0) return;
  const data = await shopifyGraphql(
    store,
    `mutation UpdateSuttonVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku }
        userErrors { field message }
      }
    }`,
    { productId, variants },
  );
  throwUserErrors(data, 'productVariantsBulkUpdate');
}

function productOptionsFromRows(rows) {
  const order = [];
  const values = new Map();
  for (const row of rows) {
    for (const pair of row.optionValues || []) {
      if (!values.has(pair.name)) {
        order.push(pair.name);
        values.set(pair.name, []);
      }
      const list = values.get(pair.name);
      if (!list.includes(pair.value)) list.push(pair.value);
    }
  }
  return order.map((name) => ({
    name,
    values: values.get(name).map((value) => ({ name: value })),
  }));
}
