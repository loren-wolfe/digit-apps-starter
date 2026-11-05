import { useCallback, useEffect, useState, type ReactNode } from 'react';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';

import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';

import { useBackendMutation, useBackendQuery, useApiQuery } from '@heysutton/sdk-react';

import ActivityLog from './ActivityLog';
import AppShell from './AppShell';
import Configuration from './Configuration';
import FulfillmentQueue from './FulfillmentQueue';
import SetupCapabilitiesDialog from './components/SetupCapabilitiesDialog';
import StatusChip from './components/StatusChip';
import type { AutoDeductStatus, FulfillmentConfig } from './types';
import type { SetupData } from './setupTypes';

type Page = 'queue' | 'activity' | 'configuration';

type Permission = { key: string };

type BootstrapData = {
  currentPermissions?: Permission[] | null;
  organization?: { id: string } | null;
};

const BOOTSTRAP_QUERY = `
  query WooCommerceFulfillmentBootstrap {
    currentPermissions { key }
    organization { id }
  }
`;

const ADMIN_PERMISSION = 'UPDATE_ORGANIZATION';

// Gate for the auto-deduct switch/banner specifically — deliberately looser than
// ADMIN_PERMISSION (org-settings admin). Automated deductions is an operational toggle for
// whoever runs fulfillment, not an org-settings change, so accept any permission this app
// already requests in its manifest that implies "can act on orders/inventory here" — not
// just full org-settings admins. Scoped to this one control; the Setup dialog's `isAdmin`
// gate is untouched.
const AUTO_DEDUCT_TOGGLE_PERMISSIONS = new Set([
  'UPDATE_ORGANIZATION',
  'update:organization',
  'UPDATE_ORDER',
  'UPDATE_INVENTORY',
]);

// Keeps the toolbar's auto-deduct switch/banner reasonably current even though nothing in
// App.tsx otherwise polls — the circuit breaker can flip `enabled` off in the background
// (during a scheduled reconcile tick) with nobody having clicked anything here.
const AUTO_DEDUCT_POLL_MS = 15000;

function setupProgress(data: SetupData | undefined) {
  if (!data?.items.length) return null;
  const required = data.items.filter((item) => item.required);
  return {
    present: required.filter((item) => item.present && item.valid).length,
    total: required.length,
  };
}

function itemPresent(data: SetupData | undefined, key: string) {
  return Boolean(data?.items.find((item) => item.key === key)?.present);
}

export default function App() {
  const [page, setPage] = useState<Page>('queue');
  const [open, setOpen] = useState(false);
  const [pullNonce, setPullNonce] = useState(0);
  const handlePulled = useCallback(() => {
    setPullNonce((nonce) => nonce + 1);
  }, []);
  const [adjustmentReasonConfigured, setAdjustmentReasonConfigured] = useState<boolean | null>(null);
  const [kitTypeFieldConfigured, setKitTypeFieldConfigured] = useState<boolean | null>(null);
  const setupQuery = useBackendQuery<SetupData>({ path: '/setup' });
  const fulfillmentConfigQuery = useBackendQuery<FulfillmentConfig>({ path: '/fulfillment/config' });
  const bootstrap = useApiQuery<BootstrapData>({ query: BOOTSTRAP_QUERY });

  const setupData = setupQuery.data;
  const organizationId = bootstrap.data?.organization?.id ?? null;
  const isAdmin = (bootstrap.data?.currentPermissions ?? []).some((permission) => {
    const key = permission.key;
    return key === ADMIN_PERMISSION || key === 'update:organization';
  });
  const canToggleAutoDeduct = (bootstrap.data?.currentPermissions ?? []).some((permission) =>
    AUTO_DEDUCT_TOGGLE_PERMISSIONS.has(permission.key),
  );

  const shellLoading = bootstrap.loading || setupQuery.loading;
  const published = setupData?.usable === true;
  const showEntry = !shellLoading && published && Boolean(organizationId);
  const progress = setupProgress(setupData);
  const setupIncomplete = progress != null && progress.total > 0 && progress.present < progress.total;

  const fulfillmentConfig = fulfillmentConfigQuery.data;
  const warehouseLocationReady = fulfillmentConfig?.warehouseLocationConfigured === true;

  // Configuration-tab automated deductions. This toggle is the only auto-apply control.
  // Read is open to anyone who can see the app; only the permission-gated switch below can write.
  const autoDeductQuery = useBackendQuery<AutoDeductStatus>({ path: '/fulfillment/auto-deduct', skip: !showEntry });
  const [mutateAutoDeduct, { loading: autoDeductMutating }] = useBackendMutation<AutoDeductStatus>();
  const autoDeductStatus = autoDeductQuery.data;
  // Distinguishes the circuit breaker tripping on its own from an operator's own manual
  // "off" — only the former gets a warning banner with a one-click re-enable, since the
  // latter is just the toggle sitting where someone deliberately left it.
  const autoDeductBreakerTripped =
    !autoDeductStatus?.enabled &&
    Boolean(autoDeductStatus?.disabledReason) &&
    autoDeductStatus?.disabledReason !== 'Turned off by operator';

  useEffect(() => {
    if (!showEntry) return;
    const id = window.setInterval(() => void autoDeductQuery.refetch(), AUTO_DEDUCT_POLL_MS);
    return () => window.clearInterval(id);
  }, [showEntry, autoDeductQuery.refetch]);

  const setAutoDeductEnabled = useCallback(
    async (enabled: boolean) => {
      const result = await mutateAutoDeduct({
        path: '/fulfillment/auto-deduct',
        method: 'POST',
        body: { enabled },
      });
      if (result.ok) void autoDeductQuery.refetch();
    },
    [mutateAutoDeduct, autoDeductQuery],
  );

  const toolbar: ReactNode = showEntry ? (
    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      {canToggleAutoDeduct && autoDeductBreakerTripped ? (
        <StatusChip
          color="error"
          label="Auto-disabled — click to re-enable"
          onClick={() => void setAutoDeductEnabled(true)}
          sx={{ cursor: 'pointer' }}
        />
      ) : null}
      {setupIncomplete && progress ? (
        <StatusChip
          color="warning"
          label={`Setup ${progress.present} of ${progress.total}`}
          onClick={() => setOpen(true)}
          sx={{ cursor: 'pointer' }}
        />
      ) : null}
      <Button
        variant="outlined"
        size="small"
        startIcon={<TuneOutlinedIcon />}
        onClick={() => setOpen(true)}
      >
        Secrets and capabilities
      </Button>
    </Stack>
  ) : null;

  return (
    <AppShell>
      <Tabs
        value={page}
        onChange={(_event, next: Page) => setPage(next)}
        sx={{ minHeight: 36, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { minHeight: 36, py: 0.5 } }}
      >
        <Tab value="queue" label="Fulfillment log" />
        <Tab value="activity" label="Activity log" />
        <Tab value="configuration" label="Configuration" />
      </Tabs>
      {page === 'queue' ? (
        <FulfillmentQueue
          toolbar={toolbar}
          onAdjustmentReasonConfigured={setAdjustmentReasonConfigured}
          onKitTypeFieldConfigured={setKitTypeFieldConfigured}
          pullNonce={pullNonce}
        />
      ) : page === 'activity' ? (
        <ActivityLog />
      ) : bootstrap.loading ? (
        <Typography sx={{ color: 'text.secondary', pt: 2 }}>Loading configuration…</Typography>
      ) : (
        <Configuration
          canEdit={canToggleAutoDeduct}
          onSaved={() => void fulfillmentConfigQuery.refetch()}
          onPulled={handlePulled}
          autoDeduct={{
            status: autoDeductStatus,
            canToggle: canToggleAutoDeduct,
            mutating: autoDeductMutating,
            breakerTripped: autoDeductBreakerTripped,
            onSetEnabled: (enabled) => void setAutoDeductEnabled(enabled),
          }}
        />
      )}
      <SetupCapabilitiesDialog
        open={open}
        onClose={() => setOpen(false)}
        showSetup={Boolean(setupData && !setupData.ready && isAdmin)}
        items={setupData?.items ?? []}
        featureStatus={{
          apiTokenPresent: itemPresent(setupData, 'API_TOKEN_SUTTON'),
          warehouseLocationReady,
          warehouseLocationCode: fulfillmentConfig?.warehouseLocationCode ?? null,
          wooCommerceConfigured: Boolean(fulfillmentConfig?.wooCommerceConfigured),
          adjustmentReasonConfigured: fulfillmentConfig ? fulfillmentConfig.adjustmentReasonConfigured : adjustmentReasonConfigured,
          kitTypeFieldConfigured: fulfillmentConfig ? fulfillmentConfig.kitTypeFieldConfigured : kitTypeFieldConfigured,
          kitTypeFieldName: fulfillmentConfig?.kitTypeFieldName,
          virtualKitOptionValue: fulfillmentConfig?.virtualKitOptionValue,
          autoDeductEnabled: autoDeductStatus?.enabled ?? null,
          autoDeductDisabledReason: autoDeductStatus?.disabledReason ?? null,
          logSince: fulfillmentConfig?.logSince ?? null,
          logSinceSource: fulfillmentConfig?.logSinceSource ?? null,
        }}
      />
    </AppShell>
  );
}
