import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';

import { parseTimestamp } from '../types';
import StatusChip from './StatusChip';

/** `unset`: an optional setting left at its default. Shown neutrally and left out of the ready count. */
type FeatureState = 'working' | 'partial' | 'off' | 'inactive' | 'unset';

type Feature = {
  title: string;
  detail: string;
  state: FeatureState;
  needs: string[];
};

export type FeatureStatusProps = {
  apiTokenPresent: boolean;
  /** A warehouse is selected on the Configuration tab and still exists in Sutton. */
  warehouseLocationReady: boolean;
  /** Display name of the configured warehouse, once resolved. */
  warehouseLocationCode: string | null;
  /** WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET are all set. */
  wooCommerceConfigured: boolean;
  /** Null while the adjustment-reason lookup has not returned. */
  adjustmentReasonConfigured: boolean | null;
  /** Null while the Kit Type field lookup has not returned. */
  kitTypeFieldConfigured: boolean | null;
  /** Names the app looks for when kit expansion is off. */
  kitTypeFieldName?: string;
  virtualKitOptionValue?: string;
  /** Null while `/fulfillment/auto-deduct` has not returned. */
  autoDeductEnabled: boolean | null;
  /** "Turned off by operator" vs. the circuit breaker's own "Auto-disabled after N
   * consecutive failures (...)" message — null while enabled or never disabled. */
  autoDeductDisabledReason: string | null;
  /** Effective log start from `/fulfillment/config`: FULFILLMENT_LOG_SINCE, else the first poll's start. */
  logSince: string | null;
  logSinceSource: 'env' | 'poll_start' | null;
};

const TOKEN = 'the Sutton API token';
const WAREHOUSE = 'a fulfillment warehouse selected on the Configuration tab';
const WOOCOMMERCE_REST = 'WooCommerce REST access (WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET)';

/** FULFILLMENT_LOG_SINCE is a calendar date parsed as UTC midnight, so show it in UTC or it reads a day early west of UTC. */
function formatLogSince(iso: string, fromEnv: boolean) {
  const d = parseTimestamp(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        ...(fromEnv ? { timeZone: 'UTC' } : {}),
      });
}

function logStartFeature(props: FeatureStatusProps): Feature {
  const title = 'Log start date (FULFILLMENT_LOG_SINCE)';
  const howTo =
    'To use a different date, set the optional FULFILLMENT_LOG_SINCE environment variable to an ISO date (e.g. 2026-08-12); the next poll re-reads completed orders from it.';
  if (props.logSinceSource === 'env' && props.logSince) {
    return {
      title,
      detail: `The poll reads completed WooCommerce orders from ${formatLogSince(props.logSince, true)}, and the queue and log hide orders received before it. Set by FULFILLMENT_LOG_SINCE. Change that environment variable to move it; the next poll re-reads completed orders from the new date.`,
      state: 'working',
      needs: [],
    };
  }
  const defaultNote = props.logSince
    ? `Using the default: the date the first poll started from, ${formatLogSince(props.logSince, false)}. The poll reads completed WooCommerce orders from it, and the queue and log hide orders received before it.`
    : 'Using the default: the first poll will start 48 hours before it runs, and that date becomes the log start.';
  return { title, detail: `${defaultNote} ${howTo}`, state: 'unset', needs: [] };
}

function gate({
  title,
  detail,
  requires,
}: {
  title: string;
  detail: string;
  requires: [boolean, string][];
}): Feature {
  const needs = requires.filter(([met]) => !met).map(([, label]) => label);
  return { title, detail, state: needs.length === 0 ? 'working' : 'off', needs };
}

// The poll reads completed orders from WooCommerce REST, then matches each one to its
// Sutton order, so it needs both the WooCommerce keys and the Sutton API token.
function features(props: FeatureStatusProps): { sutton: Feature[]; provider: Feature[] } {
  const reconcileRequires: [boolean, string][] = [
    [props.wooCommerceConfigured, WOOCOMMERCE_REST],
    [props.apiTokenPresent, TOKEN],
  ];

  const deductRequires: [boolean, string][] = [
    [props.apiTokenPresent, TOKEN],
    [props.warehouseLocationReady, WAREHOUSE],
  ];

  const warehouseName = props.warehouseLocationCode
    ? `the ${props.warehouseLocationCode} warehouse location`
    : 'your configured warehouse location';

  const breakerTripped =
    props.autoDeductEnabled === false &&
    Boolean(props.autoDeductDisabledReason) &&
    props.autoDeductDisabledReason !== 'Turned off by operator';

  const autoDeductFeature: Feature =
    props.autoDeductEnabled == null
      ? {
          title: 'Automated inventory deductions',
          detail: 'Orders matched by the scheduled poll wait at Pending approval for a manual Approve.',
          state: 'off',
          needs: [],
        }
      : props.autoDeductEnabled
        ? {
            title: 'Automated inventory deductions',
            detail:
              'On — the scheduled poll deducts stock and marks matched orders with adequate stock fulfilled automatically. Turn it off on the Configuration tab.',
            state: 'working',
            needs: [],
          }
        : {
            title: 'Automated inventory deductions',
            detail: breakerTripped
              ? `${props.autoDeductDisabledReason} Re-enable it on the Configuration tab once the underlying issue is fixed.`
              : 'Off — orders matched by the scheduled poll wait at Pending approval for a manual Approve. Turn it on from the Configuration tab.',
            state: breakerTripped ? 'partial' : 'off',
            needs: [],
          };

  return {
    sutton: [
      gate({
        title: 'Show open Sutton orders',
        detail:
          'Lists every open Sutton sales order Rutter created from WooCommerce as Awaiting completion, and matches each completed WooCommerce order to it by WooCommerce order number. This app does not write back to WooCommerce.',
        requires: [[props.apiTokenPresent, TOKEN]],
      }),
      gate({
        title: 'Deduct stock and fulfill the Sutton order',
        detail: `Deducts inventory at ${warehouseName}, then sets the Sutton order to fulfilled. Deductions use the "WooCommerce Fulfillment" adjustment reason, created on first use if it does not exist. With the Configuration switch off, matched rows wait for Approve.`,
        requires: deductRequires,
      }),
      autoDeductFeature,
      gate({
        title: 'Mark errant / Un-deduct',
        detail:
          'Reverses inventory already deducted for an order with a compensating adjustment, using a separate "WooCommerce Fulfillment Reversal" reason created on first use.',
        requires: [
          [props.apiTokenPresent, TOKEN],
          [props.warehouseLocationReady, WAREHOUSE],
        ],
      }),
    ],
    provider: [
      gate({
        title: 'Poll completed orders (woocommerce-poll)',
        detail:
          'Every 20 minutes, reads GET /wp-json/wc/v3/orders?status=completed from where the last run stopped, at most 250 pages of 100 orders per run. Only completed orders can deduct stock: an Awaiting completion row moves to Pending approval, or deducts with auto-apply on. Completed orders with no Sutton order yet are marked Unmatched instead of hidden.',
        requires: reconcileRequires,
      }),
      logStartFeature(props),
    ],
  };
}

function stateChip(state: FeatureState) {
  if (state === 'working') return <StatusChip color="success" label="Working" />;
  if (state === 'partial') return <StatusChip color="warning" label="Limited" />;
  if (state === 'inactive') return <StatusChip label="Not this mode" />;
  if (state === 'unset') return <StatusChip label="Not set" />;
  return <StatusChip label="Not yet" />;
}

function stateIcon(state: FeatureState) {
  if (state === 'working') return <CheckCircleOutlineIcon color="primary" fontSize="small" />;
  if (state === 'partial') return <ErrorOutlineIcon color="warning" fontSize="small" />;
  return <RemoveCircleOutlineIcon fontSize="small" sx={{ color: 'text.disabled' }} />;
}

function FeatureCard({ feature }: { feature: Feature }) {
  const muted = feature.state === 'inactive';
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        opacity: muted ? 0.55 : 1,
      }}
    >
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ mt: 0.25, flexShrink: 0 }}>{stateIcon(feature.state)}</Box>
        <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="subtitle2" component="h3">
              {feature.title}
            </Typography>
            {stateChip(feature.state)}
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
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
        gap: 1.5,
      }}
    >
      {cards.map((feature) => (
        <FeatureCard key={feature.title} feature={feature} />
      ))}
    </Box>
  );
}

export default function FeatureStatus(props: FeatureStatusProps) {
  const { sutton, provider } = features(props);
  const scored = [...sutton, ...provider].filter((feature) => feature.state !== 'unset');
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
        Features below turn on when the required secrets and environment variables are present, a
        warehouse is selected on the Configuration tab, and Rutter is syncing WooCommerce orders
        into Sutton. Add secrets under Secrets and environment variables under Environment variables.
        This dialog does not accept either.
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
        <FeatureGrid features={sutton} />
      </Stack>
      <Stack spacing={1}>
        <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: '0.06em' }}>
          WooCommerce
        </Typography>
        <FeatureGrid features={provider} />
      </Stack>
    </Stack>
  );
}
