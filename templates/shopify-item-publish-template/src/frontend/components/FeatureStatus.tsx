import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';

import type { SetupItem, SetupStore } from '../setupTypes';
import StatusChip from './StatusChip';

type FeatureState = 'working' | 'partial' | 'inactive' | 'off';

type Feature = {
  title: string;
  detail: string;
  state: FeatureState;
  needs: string[];
};

const SUTTON_TOKEN = 'the Sutton API token';

const STORE_SECRETS: Record<string, [string, string][]> = {
  a: [
    ['SHOPIFY_STORE_A_SHOP', 'the Store A shop subdomain'],
    ['SHOPIFY_STORE_A_CLIENT_ID', 'the Store A client ID'],
    ['SHOPIFY_STORE_A_CLIENT_SECRET', 'the Store A client secret'],
  ],
  b: [
    ['SHOPIFY_STORE_B_SHOP', 'the Store B shop subdomain'],
    ['SHOPIFY_STORE_B_CLIENT_ID', 'the Store B client ID'],
    ['SHOPIFY_STORE_B_CLIENT_SECRET', 'the Store B client secret'],
  ],
};

function secretSet(items: SetupItem[], key: string) {
  const item = items.find((entry) => entry.key === key);
  return Boolean(item?.present && item.valid);
}

function gate(title: string, detail: string, requires: [boolean, string][]): Feature {
  const needs = requires.filter(([met]) => !met).map(([, label]) => label);
  return { title, detail, state: needs.length === 0 ? 'working' : 'off', needs };
}

function publishFeature(store: SetupStore, items: SetupItem[]): Feature {
  const secrets = STORE_SECRETS[store.id] ?? [];
  const secretsMet = secrets.every(([key]) => secretSet(items, key));
  const detail =
    store.configured && !store.ready && store.error
      ? `The shop subdomain, client ID, and client secret are set, but Shopify did not accept them. ${store.error}`
      : 'Creates a draft product, or updates the Shopify product whose variant SKUs match, without deleting variants.';
  return gate(`Publish to ${store.label}`, detail, [
    [secretSet(items, 'API_TOKEN_SUTTON'), SUTTON_TOKEN],
    ...secrets.map(([key, label]) => [secretSet(items, key), label] as [boolean, string]),
    [!secretsMet || store.ready, `a connected ${store.label} account`],
  ]);
}

function features(items: SetupItem[], stores: SetupStore[]) {
  const token = secretSet(items, 'API_TOKEN_SUTTON');
  return {
    sutton: [
      gate(
        'Read Sutton items',
        'Searches items and loads the name, SKU, variants, images, category, tags, and default sales price. After a push, the chosen store’s product and variant ids are written back. The API token needs Read items (READ_ITEM), Read item cost info (READ_ITEM_COST_INFO), and Update items (UPDATE_ITEM).',
        [[token, SUTTON_TOKEN]],
      ),
    ],
    provider: stores.map((store) => publishFeature(store, items)),
  };
}

function FeatureIcon({ state }: { state: FeatureState }) {
  if (state === 'working') return <CheckCircleOutlineIcon color="primary" fontSize="small" />;
  if (state === 'partial') return <ErrorOutlineIcon color="warning" fontSize="small" />;
  return <RemoveCircleOutlineIcon fontSize="small" sx={{ color: 'text.disabled' }} />;
}

function featureChip(state: FeatureState) {
  if (state === 'working') return <StatusChip color="success" label="Working" />;
  if (state === 'partial') return <StatusChip color="warning" label="Limited" />;
  if (state === 'inactive') return <StatusChip label="Not this mode" />;
  return <StatusChip label="Not yet" />;
}

function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, height: '100%', opacity: feature.state === 'inactive' ? 0.55 : 1 }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ mt: 0.25, flexShrink: 0 }}>
          <FeatureIcon state={feature.state} />
        </Box>
        <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" component="h3">
              {feature.title}
            </Typography>
            {featureChip(feature.state)}
          </Stack>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {feature.detail}
            {feature.needs.length > 0 ? ` Needs ${feature.needs.join(' and ')}.` : ''}
          </Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}

function FeatureGrid({ features: cards }: { features: Feature[] }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
      {cards.map((feature) => (
        <FeatureCard key={feature.title} feature={feature} />
      ))}
    </Box>
  );
}

export default function FeatureStatus({ items, stores }: { items: SetupItem[]; stores: SetupStore[] }) {
  const grouped = features(items, stores);
  const scored = [...grouped.sutton, ...grouped.provider];
  const workingCount = scored.filter((feature) => feature.state === 'working').length;
  const progress = scored.length > 0 ? (workingCount / scored.length) * 100 : 0;

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography
          variant="overline"
          component="p"
          sx={{ color: 'primary.main', letterSpacing: '0.08em', lineHeight: 1.2 }}
        >
          Capabilities
        </Typography>
        <Typography variant="h2" component="h2">
          What you can do
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {workingCount} of {scored.length} features ready
        </Typography>
      </Stack>
      <Alert severity="info">
        Features below turn on when the required secrets are present and Shopify is connected. Go to
        Settings in Sutton Studio and add to Secrets. This dialog does not accept them.
      </Alert>
      <LinearProgress
        variant="determinate"
        value={progress}
        sx={{
          height: 4,
          borderRadius: 2,
          bgcolor: 'action.hover',
          '& .MuiLinearProgress-bar': { bgcolor: 'primary.main' },
        }}
      />
      <Stack spacing={1}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: '0.06em' }}>
          In Sutton
        </Typography>
        <FeatureGrid features={grouped.sutton} />
      </Stack>
      <Stack spacing={1}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: '0.06em' }}>
          Shopify
        </Typography>
        <FeatureGrid features={grouped.provider} />
      </Stack>
    </Stack>
  );
}
