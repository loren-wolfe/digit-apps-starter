import { useEffect, useMemo, useState } from 'react';

import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import PublishOutlinedIcon from '@mui/icons-material/PublishOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';

import type { AppError } from '@heysutton/sdk-react';
import { useBackendMutation, useBackendQuery } from '@heysutton/sdk-react';

import StatusChip from './components/StatusChip';
import type { SetupStore } from './setupTypes';
import {
  DEFAULT_MAPPING,
  METAFIELD_PAIRS,
  UNMAPPED_SHOPIFY_METAFIELDS,
  type Mapping,
  type PreviewData,
  type PublishData,
  type SearchItem,
  type StorePlan,
} from './types';

const PREVIEW_PLACEHOLDER = 'Select an item above to preview the values';
const PREVIEW_LOADING = 'Loading…';
const EMPTY_STORES: StorePlan[] = [];

const TABLE_SX = {
  width: '100%',
  borderCollapse: 'collapse',
  '& th, & td': { textAlign: 'left', py: 0.75, pr: 2, borderBottom: 1, borderColor: 'divider', fontSize: '0.8125rem' },
  '& th': { color: 'text.secondary', fontWeight: 600 },
} as const;

type FieldRow = {
  key: keyof Mapping;
  label: string;
  options: { value: Mapping[keyof Mapping]; label: string }[];
  preview: (values: PreviewData['values'] | null | undefined) => string;
};

const ROWS: FieldRow[] = [
  {
    key: 'title',
    label: 'Product title',
    options: [{ value: 'name', label: 'Item name' }],
    preview: (values) => values?.title || '',
  },
  {
    key: 'description',
    label: 'Product description (HTML)',
    options: [{ value: 'description', label: 'Description' }],
    preview: (values) => values?.description || '',
  },
  {
    key: 'productType',
    label: 'Product type',
    options: [{ value: 'category', label: 'Category' }],
    preview: (values) => values?.productType || '',
  },
  {
    key: 'tags',
    label: 'Product tags',
    options: [{ value: 'tags', label: 'Item tags' }],
    preview: (values) => (values?.tags || []).join(', '),
  },
  {
    key: 'sku',
    label: 'Variant SKU',
    options: [{ value: 'sku', label: 'SKU' }],
    preview: (values) => values?.skuNote || values?.sku || '',
  },
  {
    key: 'barcode',
    label: 'Variant barcode / UPC',
    options: [{ value: 'gtin', label: 'GTIN / UPC' }],
    preview: (values) => values?.barcodeNote || values?.barcode || '',
  },
  {
    key: 'price',
    label: 'Variant price',
    options: [{ value: 'defaultSalesPrice', label: 'Default sales price' }],
    preview: (values) => values?.priceNote || (values?.price ? `$${values.price}` : ''),
  },
];

function sourceLabel(row: FieldRow) {
  return row.options[0]?.label || '';
}

function CellText({ muted, children }: { muted?: boolean; children: string }) {
  return (
    <Box component="span" sx={{ color: muted ? 'text.secondary' : 'inherit', fontWeight: 400 }}>
      {children}
    </Box>
  );
}

function MissingSecret({ onOpenSetup }: { onOpenSetup: () => void }) {
  return (
    <Alert
      severity="warning"
      action={
        <Button color="inherit" size="small" onClick={onOpenSetup}>
          Open setup
        </Button>
      }
    >
      Add{' '}
      <Box component="span" sx={{ fontFamily: 'monospace' }}>
        API_TOKEN_SUTTON
      </Box>{' '}
      in Sutton Studio settings, then reload. Item search stays off until that secret is set.
    </Alert>
  );
}

function GraphError({ error, onOpenSetup }: { error: AppError; onOpenSetup: () => void }) {
  if (error.code === 'MISSING_CONFIG' || /API_TOKEN_SUTTON/.test(error.message)) {
    return <MissingSecret onOpenSetup={onOpenSetup} />;
  }
  const graphql = /Sutton GraphQL error:/i.test(error.message);
  const message = error.message.replace(/^Sutton GraphQL error:\s*/i, '');
  return (
    <Box
      role="alert"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 1.5,
        rowGap: 0.25,
        px: 2,
        py: 1.5,
        borderRadius: 1,
        border: 1,
        borderColor: 'error.dark',
        bgcolor: 'rgba(80, 16, 20, 0.72)',
      }}
    >
      <ErrorOutlineIcon color="error" fontSize="small" />
      <Typography variant="subtitle2">{graphql ? 'GraphQL error' : 'Sutton error'}</Typography>
      <Box />
      <Typography variant="body2">{message}</Typography>
      <Box />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        Support info
      </Typography>
      <Box />
      <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
        status={graphql ? 200 : error.status ?? '—'} kind={graphql ? 'graphql' : error.kind}
      </Typography>
    </Box>
  );
}

function sendable(store: StorePlan, choice?: string) {
  if (!store.ready) return false;
  if (store.action === 'create' || store.action === 'update') return true;
  if (store.action !== 'choose') return false;
  return choice === 'create' || store.collidingProducts.some((product) => product.id === choice);
}

function statusLabel(status: string | null | undefined) {
  if (!status) return '';
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

function sizePhrase(count: number, verb: string) {
  return `${count} ${count === 1 ? 'size' : 'sizes'} will be ${verb}`;
}

function pushAction(plan: StorePlan | undefined, choice: string) {
  if (!plan) return '';
  if (plan.action === 'choose') {
    if (choice === 'create') return 'create';
    if (choice) return 'update';
    return 'choose';
  }
  return plan.action;
}

function pushChip(action: string): { label: string; color: 'info' | 'primary' | 'warning' | 'error' } | null {
  if (action === 'create') return { label: 'Create draft', color: 'info' };
  if (action === 'update') return { label: 'Update', color: 'primary' };
  if (action === 'choose') return { label: 'Choose a product', color: 'warning' };
  if (action === 'blocked') return { label: 'Blocked', color: 'error' };
  if (action === 'failed' || action === 'unavailable') return { label: 'Needs attention', color: 'error' };
  return null;
}

function pushSentence(plan: StorePlan, choice: string, counts?: { updated: number; added: number } | null) {
  const action = pushAction(plan, choice);
  if (action === 'create' && plan.action === 'choose') return 'New draft. The products listed above stay unchanged.';
  if (action === 'create') {
    const count = counts?.added ?? plan.createSkus?.length ?? 0;
    return count > 0 ? `New draft. ${sizePhrase(count, 'created')}.` : 'New draft.';
  }
  if (action === 'update' && plan.action === 'choose') {
    const product = plan.collidingProducts.find((entry) => entry.id === choice);
    const status = statusLabel(product?.status);
    return `Updates ${product?.title || 'the product you chose'}.${status ? ` Status stays ${status}.` : ''}`;
  }
  if (action === 'update') {
    const status = statusLabel(plan.product?.status);
    const updated = counts?.updated ?? plan.updateSkus?.length ?? 0;
    const added = counts?.added ?? plan.createSkus?.length ?? 0;
    const parts = [`Updates ${plan.product?.title || 'the matching product'}.`];
    if (status) parts.push(`Status stays ${status}.`);
    if (updated > 0 && added > 0) parts.push(`${sizePhrase(updated, 'updated')} and ${sizePhrase(added, 'added')}.`);
    else if (updated > 0) parts.push(`${sizePhrase(updated, 'updated')}.`);
    else if (added > 0) parts.push(`${sizePhrase(added, 'added')}.`);
    return parts.join(' ');
  }
  if (action === 'choose') return 'These SKUs match more than one product.';
  return plan.error || '';
}

function sameSku(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ShopifyLink({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <Stack spacing={0.25} sx={{ minWidth: 0, flexBasis: '100%' }}>
      <Button size="small" onClick={() => void copy()} sx={{ alignSelf: 'flex-start' }}>
        {state === 'copied' ? 'Link copied' : 'Copy Shopify link'}
      </Button>
      <Typography variant="caption" sx={{ color: 'text.secondary', wordBreak: 'break-all' }}>
        {state === 'failed'
          ? 'Select this address and paste it in your browser.'
          : 'Paste this address in your browser to open the product.'}
      </Typography>
      <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
        {url}
      </Typography>
    </Stack>
  );
}

function ProductChoice({
  store,
  value,
  disabled,
  onChange,
}: {
  store: StorePlan;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <RadioGroup
      aria-label={`Shopify product for ${store.label}`}
      name={`shopify-product-${store.id}`}
      value={value}
      onChange={(_event, next) => onChange(next)}
      sx={{ pl: 4 }}
    >
      {store.collidingProducts.map((product) => {
        const skus = (product.skus || []).filter(Boolean);
        const detail = [statusLabel(product.status), skus.length > 0 ? `SKUs: ${skus.join(', ')}` : '']
          .filter(Boolean)
          .join(' · ');
        return (
          <FormControlLabel
            key={product.id}
            value={product.id}
            disabled={disabled}
            control={<Radio size="small" />}
            label={
              <Box>
                <Typography variant="body2">{product.title}</Typography>
                {detail ? (
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                    {detail}
                  </Typography>
                ) : null}
              </Box>
            }
          />
        );
      })}
      <FormControlLabel
        value="create"
        disabled={disabled}
        control={<Radio size="small" />}
        label={
          <Box>
            <Typography variant="body2">Create a new draft</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
              Leaves the products above unchanged.
            </Typography>
          </Box>
        }
      />
    </RadioGroup>
  );
}

export default function Publisher({
  setupStores,
  setupKnown,
  suttonTokenPresent,
  onOpenSetup,
}: {
  setupStores: SetupStore[];
  setupKnown: boolean;
  suttonTokenPresent: boolean;
  onOpenSetup: () => void;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [idStore, setIdStore] = useState('');
  const [extraIds, setExtraIds] = useState<string[]>([]);
  const [variantQuery, setVariantQuery] = useState('');
  const [results, setResults] = useState<PublishData['results'] | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    const handle = window.setTimeout(() => setVariantQuery(extraIds.join(',')), 250);
    return () => window.clearTimeout(handle);
  }, [extraIds]);

  const itemsQuery = useBackendQuery<{ items: SearchItem[] }>({
    path: `/items?search=${encodeURIComponent(search)}`,
    skip: !suttonTokenPresent,
  });
  const previewPath = selected
    ? `/items/${encodeURIComponent(selected.id)}/preview?mapping=${encodeURIComponent(JSON.stringify(DEFAULT_MAPPING))}${variantQuery ? `&variants=${encodeURIComponent(variantQuery)}` : ''}`
    : '/items/preview';
  const previewQuery = useBackendQuery<PreviewData>({ path: previewPath, skip: !selected });
  const [publish, publishState] = useBackendMutation<PublishData>();

  const items = itemsQuery.data?.items ?? [];
  const preview = previewQuery.data;
  const previewMatches = preview != null && preview.item?.id === selected?.id;
  const values = previewMatches ? preview.values : null;
  const mappingLoading = Boolean(selected) && !previewMatches && !previewQuery.error;
  const stores = previewMatches ? preview.stores : EMPTY_STORES;
  const planKey = stores.map((store) => `${store.id}:${store.action}:${store.ready}`).join('|');

  useEffect(() => {
    setResults(null);
    setChoices({});
    setIdStore('');
    setExtraIds([]);
    setVariantQuery('');
  }, [selected?.id]);

  useEffect(() => {
    if (!planKey) return;
    setChoices({});
    setChecked(Object.fromEntries(stores.map((store) => [store.id, sendable(store)])));
  }, [planKey]);

  const selectedStores = useMemo(
    () => stores.filter((store) => checked[store.id] && sendable(store, choices[store.id])),
    [stores, checked, choices],
  );
  const chosenIdStore = selectedStores.some((store) => store.id === idStore) ? idStore : '';
  const needsIdStore = selectedStores.length > 1;
  const variantChoices = values?.variants ?? [];
  const includedIds = new Set(selected ? [selected.id, ...extraIds] : extraIds);
  const selectableVariantIds = variantChoices
    .filter((variant) => variant.itemId !== selected?.id && !variant.issue)
    .map((variant) => variant.itemId);
  const allSizesIncluded = selectableVariantIds.length > 0 && selectableVariantIds.every((id) => extraIds.includes(id));

  function setVariantIncluded(itemId: string, next: boolean) {
    setExtraIds((current) => {
      if (next) return current.includes(itemId) ? current : [...current, itemId];
      return current.filter((id) => id !== itemId);
    });
  }

  const plannedIds = variantChoices.filter((variant) => variant.selected).map((variant) => variant.itemId);
  const selectionSettled = plannedIds.length === includedIds.size
    && plannedIds.every((id) => includedIds.has(id));

  function selectionCounts(plan: StorePlan, choice: string) {
    const action = pushAction(plan, choice);
    const included = variantChoices.filter((variant) => includedIds.has(variant.itemId) && !variant.issue && variant.sku);
    if (action === 'create' && plan.action !== 'choose') return { updated: 0, added: included.length };
    if (action !== 'update' || plan.action === 'choose' || !Array.isArray(plan.productSkus)) return null;
    let updated = 0;
    let added = 0;
    for (const variant of included) {
      if (plan.productSkus.some((sku) => sameSku(sku, variant.sku))) updated += 1;
      else added += 1;
    }
    return { updated, added };
  }

  function variantPushLabel(sku: string) {
    if (!sku || selectedStores.length === 0) return '';
    const labels = selectedStores.map((store) => {
      const action = pushAction(store, choices[store.id] || '');
      if (action === 'create') return 'Create';
      if (action !== 'update') return '';
      if (Array.isArray(store.productSkus)) {
        return store.productSkus.some((entry) => sameSku(entry, sku)) ? 'Update' : 'Add size';
      }
      if ((store.updateSkus || []).some((entry) => sameSku(entry, sku))) return 'Update';
      if ((store.createSkus || []).some((entry) => sameSku(entry, sku))) return 'Add size';
      return selectionSettled ? 'Update' : '';
    }).filter(Boolean);
    const unique = [...new Set(labels)];
    if (unique.length === 1) return unique[0];
    return unique.length > 1 ? 'See destinations' : '';
  }

  const confirmText = (() => {
    const actions = selectedStores.map((store) => pushAction(store, choices[store.id] || ''));
    const creating = actions.includes('create');
    const updating = actions.includes('update');
    if (creating && updating) return 'Create and update';
    if (creating) return selectedStores.length > 1 ? 'Create drafts' : 'Create draft';
    if (updating) return selectedStores.length > 1 ? 'Update products' : 'Update';
    return 'Confirm and push data';
  })();

  async function push(storeIds: string[]) {
    if (!selected || storeIds.length === 0) return;
    const targets: Record<string, string> = {};
    for (const storeId of storeIds) {
      const store = stores.find((entry) => entry.id === storeId);
      const choice = choices[storeId];
      if (store?.action === 'choose' && choice) targets[storeId] = choice;
    }
    const saveFrom = storeIds.length === 1 ? storeIds[0] : chosenIdStore;
    const result = await publish({
      path: '/publish',
      method: 'POST',
      body: {
        itemId: selected.id,
        mapping: DEFAULT_MAPPING,
        stores: storeIds,
        targets,
        idStore: saveFrom,
        variantIds: [selected.id, ...extraIds],
      },
    });
    if (result.ok) {
      setResults(result.data.results);
      void previewQuery.refetch();
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Stack spacing={0.5}>
          <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: '0.08em' }}>
            Commerce publishing
          </Typography>
          <Typography variant="h4" component="h1">
            Map Sutton items to Shopify
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', maxWidth: 640 }}>
            Choose the fields to send, review their values, choose the available Shopify destinations, then confirm the publish.
          </Typography>
        </Stack>
      </Stack>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="subtitle1" component="h2">
              1. Choose an item
            </Typography>
            <Button
              size="small"
              variant="outlined"
              disabled={!suttonTokenPresent}
              onClick={() => {
                void itemsQuery.refetch();
                if (selected) void previewQuery.refetch();
              }}
            >
              Refresh from Sutton
            </Button>
          </Stack>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Results refresh live from Sutton and match only item names and SKUs. Only active items can be published.
          </Typography>
          {setupKnown && !suttonTokenPresent ? <MissingSecret onOpenSetup={onOpenSetup} /> : null}
          {suttonTokenPresent && itemsQuery.error ? <GraphError error={itemsQuery.error} onOpenSetup={onOpenSetup} /> : null}
          <Autocomplete
            options={items}
            value={selected}
            disabled={!suttonTokenPresent}
            loading={itemsQuery.loading}
            inputValue={searchInput}
            onInputChange={(_event, value, reason) => {
              if (reason === 'reset') return;
              setSearchInput(value);
            }}
            onChange={(_event, value) => {
              setSelected(value);
              setResults(null);
            }}
            getOptionLabel={(option) => (option.sku ? `${option.name} · ${option.sku}` : option.name)}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => <TextField {...params} placeholder="Search live Sutton items" size="small" />}
            noOptionsText={itemsQuery.loading ? 'Searching Sutton…' : 'No items match'}
          />
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack spacing={2}>
          <Stack spacing={0.5}>
            <Typography variant="subtitle1" component="h2">
              2. Field mapping
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Sutton is on the left and the Shopify field it writes is beside it. A field with nothing entered is cleared in Shopify.
            </Typography>
          </Stack>
          {mappingLoading ? (
            <Stack spacing={1} role="status" aria-live="polite">
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <CircularProgress size={16} />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Loading field values for {selected?.sku ? `${selected.name} · ${selected.sku}` : selected?.name}
                </Typography>
              </Stack>
              <LinearProgress aria-label="Loading field values" />
            </Stack>
          ) : null}
          <Box sx={{ overflowX: 'auto' }} aria-busy={mappingLoading}>
            <Box component="table" sx={[TABLE_SX, { tableLayout: 'fixed' }]}>
              <colgroup>
                <col style={{ width: '34%' }} />
                <col style={{ width: '33%' }} />
                <col style={{ width: '33%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Sutton field</th>
                  <th>Shopify product field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => {
                  const sent = row.preview(values);
                  const label = mappingLoading ? PREVIEW_LOADING : !values ? PREVIEW_PLACEHOLDER : sent;
                  return (
                    <tr key={row.key}>
                      <td>
                        <CellText>{sourceLabel(row)}</CellText>
                      </td>
                      <td>
                        <CellText>{row.label}</CellText>
                      </td>
                      <td>
                        <CellText muted={mappingLoading || !sent}>{label}</CellText>
                      </td>
                    </tr>
                  );
                })}
                {METAFIELD_PAIRS.map((pair) => {
                  const preview = values?.metafields?.find((row) => row.sutton === pair.sutton);
                  const sent = preview?.value || '';
                  const label = mappingLoading ? PREVIEW_LOADING : !values ? PREVIEW_PLACEHOLDER : preview?.note || sent;
                  return (
                    <tr key={pair.sutton}>
                      <td>
                        <CellText>{pair.sutton}</CellText>
                      </td>
                      <td>
                        <CellText>{pair.shopify}</CellText>
                      </td>
                      <td>
                        <CellText muted={mappingLoading || !sent}>{label}</CellText>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Box>
          </Box>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Not sent: {UNMAPPED_SHOPIFY_METAFIELDS.join(', ')}.
          </Typography>

          {values && values.variants.length > 0 ? (
            <Stack spacing={1} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Variants
                </Typography>
                {selectableVariantIds.length > 0 ? (
                  <Button
                    size="small"
                    onClick={() => setExtraIds(allSizesIncluded ? [] : selectableVariantIds)}
                  >
                    {allSizesIncluded ? 'Only this size' : 'Include all sizes'}
                  </Button>
                ) : null}
              </Stack>
              {values.styleColor ? (
                <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                  Style# + Color {values.styleColor}. Each size is a variant with Size and this colorway's Color.{' '}
                  {values.variants.filter((variant) => includedIds.has(variant.itemId)).length} of{' '}
                  {values.variants.length} sizes will be sent. The item you picked is included. Check other sizes to send them on the same product.
                </Typography>
              ) : null}
              {values.memberOverflow ? (
                <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                  Some sizes in this colorway are not in this list.
                </Typography>
              ) : null}
              <Box sx={{ overflowX: 'auto' }}>
                <Box component="table" sx={TABLE_SX}>
                  <thead>
                    <tr>
                      {values.variants.length > 1 ? <th>Include</th> : null}
                      <th>Variant</th>
                      <th>Options</th>
                      <th>SKU</th>
                      <th>Barcode</th>
                      <th>Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {values.variants.map((variant) => {
                      const picked = variant.itemId === selected?.id;
                      const included = includedIds.has(variant.itemId);
                      const pushLabel = included && !variant.issue ? variantPushLabel(variant.sku) : '';
                      const missingSku = included && !variant.sku;
                      const missingPrice = included && (variant.price == null || variant.price <= 0);
                      return (
                        <tr key={variant.itemId}>
                          {values.variants.length > 1 ? (
                            <td>
                              <Checkbox
                                size="small"
                                checked={picked || (included && !variant.issue)}
                                disabled={picked || Boolean(variant.issue) || publishState.loading}
                                onChange={(_event, next) => setVariantIncluded(variant.itemId, next)}
                                slotProps={{ input: { 'aria-label': `Include ${variant.name}` } }}
                                sx={{ p: 0.25 }}
                              />
                            </td>
                          ) : null}
                          <td>
                            {variant.name}
                            {variant.issue ? (
                              <Typography component="div" variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
                                {variant.issue}
                              </Typography>
                            ) : null}
                            {pushLabel ? (
                              <Typography
                                component="div"
                                variant="caption"
                                sx={{
                                  display: 'block',
                                  fontWeight: 700,
                                  color: pushLabel === 'Update' ? 'text.primary' : 'info.main',
                                }}
                              >
                                {pushLabel}
                              </Typography>
                            ) : null}
                          </td>
                          <td>{variant.optionsLabel || '—'}</td>
                          <td>
                            <Typography component="span" variant="body2" sx={{ color: missingSku ? 'warning.main' : 'text.primary', fontWeight: 400 }}>
                              {variant.sku || 'Missing'}
                            </Typography>
                          </td>
                          <td>{variant.barcode || '—'}</td>
                          <td>
                            <Typography component="span" variant="body2" sx={{ color: missingPrice ? 'warning.main' : 'text.primary', fontWeight: 400 }}>
                              {variant.priceLabel ? `$${variant.priceLabel}` : 'Missing'}
                            </Typography>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Box>
              </Box>
              {values.variants.some((variant) => includedIds.has(variant.itemId) && (!variant.sku || variant.price == null || variant.price <= 0)) ? (
                <Typography variant="body2" sx={{ color: 'warning.main' }}>
                  A variant with no SKU, or a new variant with no price above zero, blocks Send for the store that would create it.
                </Typography>
              ) : null}
            </Stack>
          ) : null}

          <Box sx={{ bgcolor: 'action.hover', borderRadius: 1, px: 2, py: 1.5 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Automatic product matching
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Matching uses the SKUs you include. One matching Shopify product is updated. When those SKUs are on more than one product, choose which product to update. Variants already in Shopify are updated when the SKU matches, included sizes that are missing are added, and other Shopify variants are left in place.
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
        <Stack spacing={1.5}>
          <Stack spacing={0.5}>
            <Typography variant="subtitle1" component="h2">
              3. Confirm destinations and publish
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Each store says whether this push creates a draft or updates a product that is already there.
            </Typography>
          </Stack>
          {previewQuery.error ? <GraphError error={previewQuery.error} onOpenSetup={onOpenSetup} /> : null}
          {(stores.length > 0 ? stores : setupStores).map((store) => {
            const plan = stores.find((entry) => entry.id === store.id);
            const domain = plan?.domain || ('domain' in store ? store.domain : null) || store.label;
            const ready = Boolean(plan?.ready ?? ('ready' in store ? store.ready : false));
            const choice = plan ? choices[plan.id] || '' : '';
            const canSend = plan ? sendable(plan, choice) : false;
            const action = pushAction(plan, choice);
            const chip = pushChip(action);
            const sentence = plan ? pushSentence(plan, choice, selectionCounts(plan, choice)) : '';
            return (
              <Stack key={store.id} spacing={0.5} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <StorefrontOutlinedIcon fontSize="small" />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2">{domain}</Typography>
                    {sentence ? (
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                        {sentence}
                      </Typography>
                    ) : null}
                  </Box>
                  {chip ? <StatusChip color={chip.color} label={chip.label} /> : null}
                  <FormControlLabel
                    control={
                      <Checkbox
                        size="small"
                        checked={Boolean(checked[store.id]) && canSend}
                        disabled={!canSend || publishState.loading}
                        onChange={(_event, next) => setChecked((current) => ({ ...current, [store.id]: next }))}
                      />
                    }
                    label="Send"
                  />
                  <StatusChip color={ready ? 'success' : 'warning'} label={ready ? 'Ready' : 'Needs setup'} />
                </Stack>
                {plan?.action === 'choose' ? (
                  <ProductChoice
                    store={plan}
                    value={choice}
                    disabled={publishState.loading}
                    onChange={(next) => {
                      setChoices((current) => ({ ...current, [plan.id]: next }));
                      setChecked((current) => ({ ...current, [plan.id]: true }));
                    }}
                  />
                ) : null}
              </Stack>
            );
          })}
          {needsIdStore ? (
            <Stack spacing={0.5} sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
              <Typography variant="body2">Save Shopify ids from</Typography>
              <RadioGroup value={chosenIdStore} onChange={(_event, value) => setIdStore(value)}>
                {selectedStores.map((store) => (
                  <FormControlLabel
                    key={store.id}
                    value={store.id}
                    control={<Radio size="small" />}
                    label={store.domain || store.label}
                  />
                ))}
              </RadioGroup>
            </Stack>
          ) : null}
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', pt: 1 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {selectedStores.length} {selectedStores.length === 1 ? 'destination' : 'destinations'} selected
            </Typography>
            <Button
              variant="contained"
              disabled={!selected || selectedStores.length === 0 || publishState.loading || (needsIdStore && !chosenIdStore)}
              startIcon={<PublishOutlinedIcon />}
              onClick={() => void push(selectedStores.map((store) => store.id))}
            >
              {confirmText}
            </Button>
          </Stack>
          {publishState.error ? <GraphError error={publishState.error} onOpenSetup={onOpenSetup} /> : null}
          {results?.map((result) => (
            <Stack key={result.id} direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusChip
                color={result.status === 'failed' ? 'error' : result.status === 'created' ? 'info' : 'primary'}
                label={result.actionLabel}
              />
              <Typography variant="body2">{result.message}</Typography>
              {result.adminUrl ? <ShopifyLink key={result.adminUrl} url={result.adminUrl} /> : null}
              {result.status === 'failed' ? (
                <Button size="small" disabled={publishState.loading} onClick={() => void push([result.id])}>
                  Retry
                </Button>
              ) : null}
            </Stack>
          ))}
        </Stack>
      </Paper>
    </Stack>
  );
}
