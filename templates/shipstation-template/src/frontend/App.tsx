import { useState, type ReactNode } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import {
  AppErrorAlert,
  useBackendMutation,
  useBackendQuery,
  useApiQuery,
} from '@heysutton/sdk-react';

import ActivityLog, { useActivityQuery } from './ActivityLog';
import type {
  CarrierDraft,
  OrgSettingsData,
} from './carrierTypes';
import {
  draftFromOrgSettings,
  mappingsFromDraft,
  pushBlockedDigitCarriersFrom,
} from './carrierTypes';
import AppShell from './components/AppShell';
import CarrierSettingsDialog from './components/CarrierSettingsDialog';
import ConnectionBar, { ConnectPanel, NonAdminNotice } from './components/ConnectionBar';
import SectionHeader from './components/SectionHeader';
import SetupCapabilitiesDialog from './components/SetupCapabilitiesDialog';
import SourceFilterField, { sourceFilterInvalid } from './components/SourceFilterField';
import type { SourceFilterSettings } from './sourceFilter';
import FulfillmentQueue from './FulfillmentQueue';
import type { SetupData } from './setupTypes';
import { useRefetchWhenVisible } from './useRefetchWhenVisible';

type Permission = { key: string };

type BootstrapData = {
  currentPermissions?: Permission[] | null;
  organization?: { id: string } | null;
};

const BOOTSTRAP_QUERY = `
  query ShipStationBootstrap {
    currentPermissions { key }
    organization { id }
  }
`;

const ADMIN_PERMISSION = 'UPDATE_ORGANIZATION';

const SETTING_HINTS = {
  defaultFulfillmentMethod:
    'Manual push (the default) only sends eligible awaiting-carrier shipments when you click Push to ShipStation. Scheduled push also sends them every five minutes.',
  defaultWeightOz:
    'Package weight sent to ShipStation on push. Sutton shipments have no weight field, so this default applies to every push.',
  sourceFilter:
    'Source is the Source column on the Sutton sales order table. When on, shipments from other sources are hidden from the queue and never pushed. Shipments already in ShipStation stay visible.',
} as const;

const settingTooltipSlotProps = {
  tooltip: {
    sx: {
      maxWidth: 320,
      whiteSpace: 'normal',
      display: 'block',
      textTransform: 'none',
      letterSpacing: 'normal',
      fontWeight: 400,
      lineHeight: 1.45,
      fontSize: 14,
      py: 1,
      px: 1.25,
    },
  },
};

function FieldHelp({ title, label }: { title: string; label: string }) {
  return (
    <Tooltip title={title} placement="left" enterTouchDelay={0} slotProps={settingTooltipSlotProps}>
      <IconButton type="button" size="small" aria-label={`About ${label}`} sx={{ color: 'text.secondary' }}>
        <InfoOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

function SettingField({
  title,
  label,
  children,
}: {
  title: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
      <FieldHelp title={title} label={label} />
    </Stack>
  );
}

type ConnectionData = {
  connected: boolean;
  organizationId?: string;
  id?: number;
  carrierCount?: number;
  apiVersion?: 'v1' | 'v2' | string;
  mismatch?: string;
  /** Connection row exists but ShipStation secrets were removed — not operable. */
  credentialsMissing?: boolean;
  staleConnection?: boolean;
};

type SettingsDraft = {
  defaultFulfillmentMethod: string;
  defaultWeightOz: string;
  sourceFilter: SourceFilterSettings;
};

function draftFromOrg(orgSettings: OrgSettingsData | undefined): SettingsDraft {
  return {
    defaultFulfillmentMethod:
      orgSettings?.defaultFulfillmentMethod === 'scheduled' ? 'scheduled' : 'manual',
    defaultWeightOz: String(orgSettings?.defaultWeightOz ?? 16),
    sourceFilter: {
      enabled: Boolean(orgSettings?.sourceFilter?.enabled),
      keys: [...(orgSettings?.sourceFilter?.keys ?? [])],
    },
  };
}

function setupProgressFrom(data: SetupData | undefined) {
  if (!data?.items?.length) return null;
  const required = data.items.filter((item) => item.required);
  const present = required.filter((item) => item.present).length;
  return { present, total: required.length };
}

export default function App() {
  const setupQuery = useBackendQuery<SetupData>({ path: '/setup' });
  const setupData = setupQuery.data;
  const apiTokenPresent = Boolean(setupData?.apiTokenPresent);
  const shipStationKeyPresent = Boolean(setupData?.shipStationKeyPresent);
  const setupIncomplete = setupData != null && !setupData.ready;
  const notPublished = setupData != null && !setupData.usable;

  const bootstrap = useApiQuery<BootstrapData>({ query: BOOTSTRAP_QUERY });
  const organizationId = bootstrap.data?.organization?.id ?? null;
  const isAdmin = (bootstrap.data?.currentPermissions ?? []).some((permission) => {
    const key = permission.key;
    return key === ADMIN_PERMISSION || key === 'update:organization';
  });

  const configLoaded = setupData != null && setupData.usable;
  const connectionQuery = useBackendQuery<ConnectionData>({
    path: `/connection?organizationId=${encodeURIComponent(organizationId ?? '')}`,
    skip: !organizationId || !configLoaded,
  });
  const orgSettingsQuery = useBackendQuery<OrgSettingsData>({
    path: `/org-settings?organizationId=${encodeURIComponent(organizationId ?? '')}`,
    skip: !organizationId || !configLoaded,
  });
  const activityQuery = useActivityQuery(organizationId ?? '');
  useRefetchWhenVisible(async () => {
    await orgSettingsQuery.refetch();
    await activityQuery.refetch();
  });
  const connected = Boolean(connectionQuery.data?.connected);
  const credentialsMissing = Boolean(
    connectionQuery.data?.credentialsMissing || connectionQuery.data?.staleConnection,
  );
  /** Secrets removed after connect leave a D1 row — do not show the queue until restored or disconnected. */
  const operable = connected && !credentialsMissing;

  const [mutate, { error: mutationError, loading: mutating, reset: resetMutation }] =
    useBackendMutation<ConnectionData>();
  const [checkSetup] = useBackendMutation<SetupData>();

  const [workspace, setWorkspace] = useState<'queue' | 'activity'>('queue');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [carrierSettingsOpen, setCarrierSettingsOpen] = useState(false);
  const [setupCapabilitiesOpen, setSetupCapabilitiesOpen] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [carrierDraft, setCarrierDraft] = useState<CarrierDraft | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [connectBlocker, setConnectBlocker] = useState<string | null>(null);

  const connect = async () => {
    if (!organizationId) return;
    resetMutation();
    setSuccessNotice(null);
    setConnectBlocker(null);

    // Fresh setup read so we never POST when Digit secrets were just removed.
    const setupResult = await checkSetup({ path: '/setup', method: 'GET' });
    if (!setupResult.ok) {
      setConnectBlocker(
        setupResult.error.code === 'BACKEND_UNAVAILABLE'
          ? 'The app backend is unavailable, so Connect cannot check your ShipStation API key. Wait a moment and try again.'
          : setupResult.error.message ||
              'Could not verify ShipStation setup before connecting.',
      );
      await setupQuery.refetch();
      return;
    }
    await setupQuery.refetch();
    if (!setupResult.data?.shipStationKeyPresent) {
      setConnectBlocker(
        'No ShipStation API key is configured. Add SHIPSTATION_API_KEY to this app’s secrets in Sutton (and SHIPSTATION_API_SECRET only for V1), then reload and connect.',
      );
      return;
    }

    const result = await mutate({
      path: '/connection',
      method: 'POST',
      body: { organizationId },
    });
    if (!result.ok) return;
    const carriers = result.data?.carrierCount ?? 0;
    const version = result.data?.apiVersion === 'v1' ? 'V1' : 'V2';
    setSuccessNotice(
      `Connected to ShipStation ${version} and synced ${carriers} carrier(s). Create Sutton shipments, then push from the shipping queue to purchase a label.`,
    );
    await connectionQuery.refetch();
    await orgSettingsQuery.refetch();
  };

  const openSettings = () => {
    if (!operable) return;
    resetMutation();
    setSuccessNotice(null);
    setDraft(draftFromOrg(orgSettingsQuery.data));
    setSettingsOpen(true);
  };

  const openCarrierSettings = () => {
    if (!operable || !isAdmin) return;
    resetMutation();
    setSuccessNotice(null);
    setCarrierDraft(draftFromOrgSettings(orgSettingsQuery.data));
    setCarrierSettingsOpen(true);
  };

  const saveSettings = async () => {
    if (!organizationId || !draft) return;
    resetMutation();
    const orgResult = await mutate({
      path: '/org-settings',
      method: 'PATCH',
      body: {
        organizationId,
        defaultFulfillmentMethod: draft.defaultFulfillmentMethod,
        defaultWeightOz: Number(draft.defaultWeightOz),
        sourceFilter: draft.sourceFilter,
      },
    });
    if (!orgResult.ok) return;
    setSettingsOpen(false);
    setSuccessNotice(
      'Settings saved. New pushes use these rules; orders already in ShipStation are unchanged.',
    );
    await orgSettingsQuery.refetch();
  };

  const saveCarrierMappings = async () => {
    if (!organizationId || !carrierDraft) return;
    resetMutation();
    if (orgSettingsQuery.data?.digitCarriersError) return;
    const orgResult = await mutate({
      path: '/org-settings',
      method: 'PATCH',
      body: {
        organizationId,
        mappings: mappingsFromDraft(carrierDraft),
      },
    });
    if (!orgResult.ok) return;
    setCarrierSettingsOpen(false);
    setSuccessNotice(
      'Carrier mapping saved. The next label writeback uses these Sutton shipping carriers.',
    );
    await orgSettingsQuery.refetch();
  };

  const loading =
    setupQuery.loading ||
    bootstrap.loading ||
    (!!organizationId && configLoaded && (connectionQuery.loading || orgSettingsQuery.loading));

  const showContent = !notPublished && !setupQuery.error;
  const backendUnavailable =
    setupQuery.error?.code === 'BACKEND_UNAVAILABLE' ||
    connectionQuery.error?.code === 'BACKEND_UNAVAILABLE' ||
    orgSettingsQuery.error?.code === 'BACKEND_UNAVAILABLE' ||
    mutationError?.code === 'BACKEND_UNAVAILABLE';
  const canOfferConnect = !backendUnavailable && !connectionQuery.error;
  const digitCarriersError = orgSettingsQuery.data?.digitCarriersError ?? null;
  /** Push direction: Digit carriers with no single confirmed ShipStation service. */
  const pushBlockedCarriers = digitCarriersError
    ? []
    : pushBlockedDigitCarriersFrom(orgSettingsQuery.data);
  const pushBlockedLabel = pushBlockedCarriers
    .map((row) => row.digitValue)
    .filter(Boolean)
    .join(', ');
  const activityErrorCount = (activityQuery.data?.events ?? []).filter(
    (event) => event.status === 'error' || event.status === 'failed',
  ).length;
  const featureStatusProps = {
    connected: operable,
    apiTokenPresent,
    shipStationKeyPresent,
    shipStationApiMode: setupData?.shipStationApiMode,
    shipStationSecretPresent: Boolean(setupData?.shipStationSecretPresent),
  };

  return (
    <AppShell
      commandBar={
        <ConnectionBar
          connected={connected}
          operable={operable}
          credentialsMissing={credentialsMissing}
          apiVersion={connectionQuery.data?.apiVersion}
          carrierCount={connectionQuery.data?.carrierCount}
          pushBlockedCarrierCount={pushBlockedCarriers.length}
          loading={loading}
          isAdmin={isAdmin}
          shipStationKeyPresent={shipStationKeyPresent}
          setupProgress={setupProgressFrom(setupData)}
          organizationId={organizationId}
          notPublished={notPublished}
          mutating={mutating}
          onConnect={() => void connect()}
          onOpenSettings={openSettings}
          onOpenCarrierSettings={openCarrierSettings}
          onOpenSetupCapabilities={() => setSetupCapabilitiesOpen(true)}
        />
      }
    >
      {setupQuery.error && (
        <AppErrorAlert error={setupQuery.error} onRetry={() => void setupQuery.refetch()} />
      )}
      {notPublished && (
        <Alert severity="error">
          This app is not fully published, so its backend has no database. Republish it, then reload.
        </Alert>
      )}
      {bootstrap.error && (
        <AppErrorAlert error={bootstrap.error} onRetry={() => void bootstrap.refetch()} />
      )}
      {connectionQuery.error && (
        <AppErrorAlert error={connectionQuery.error} onRetry={() => void connectionQuery.refetch()} />
      )}
      {orgSettingsQuery.error && (
        <AppErrorAlert error={orgSettingsQuery.error} onRetry={() => void orgSettingsQuery.refetch()} />
      )}
      {mutationError && <AppErrorAlert error={mutationError} />}
      {connectBlocker ? (
        <Alert severity="warning" onClose={() => setConnectBlocker(null)}>
          {connectBlocker}
        </Alert>
      ) : null}
      {connectionQuery.data?.mismatch ? (
        <Alert severity="warning">{connectionQuery.data.mismatch}</Alert>
      ) : null}
      {credentialsMissing ? (
        <Alert severity="warning">
          ShipStation app secrets were removed, so this org is <strong>not connected</strong> even
          though a local connection record remains. Restore <strong>SHIPSTATION_API_KEY</strong> and
          reload. Connect will replace the leftover record with the current secrets.
        </Alert>
      ) : null}
      {successNotice ? (
        <Alert severity="success" onClose={() => setSuccessNotice(null)}>
          {successNotice}
        </Alert>
      ) : null}
      {operable && digitCarriersError ? (
        <Alert severity="warning">{digitCarriersError}</Alert>
      ) : null}
      {operable && pushBlockedCarriers.length > 0 ? (
        <Alert
          severity="error"
          action={
            isAdmin ? (
              <Button color="inherit" size="small" onClick={openCarrierSettings}>
                Map carriers
              </Button>
            ) : null
          }
        >
          {`${pushBlockedCarriers.length} Sutton shipping carrier${
            pushBlockedCarriers.length === 1 ? '' : 's'
          } cannot push to ShipStation (${pushBlockedLabel}). Shipments using ${
            pushBlockedCarriers.length === 1 ? 'it' : 'them'
          } stay blocked in the queue. `}
          {isAdmin
            ? 'Open Carrier configuration → Sutton carriers and pick one ShipStation service for each.'
            : 'An org admin must map them in Carrier configuration.'}
        </Alert>
      ) : null}

      {showContent && operable && organizationId ? (
        <Paper
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <Tabs
            value={workspace}
            onChange={(_, value: 'queue' | 'activity') => setWorkspace(value)}
            aria-label="Queue and activity"
            sx={{ px: { xs: 1.5, sm: 2 }, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
          >
            <Tab value="queue" label="Queue" />
            <Tab
              value="activity"
              label={activityErrorCount > 0 ? `Activity (${activityErrorCount} errors)` : 'Activity'}
            />
          </Tabs>
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: workspace === 'queue' ? 'flex' : 'none',
              flexDirection: 'column',
              overflow: 'hidden',
              p: { xs: 1.5, sm: 2 },
            }}
          >
            <FulfillmentQueue
              organizationId={organizationId}
              canPush
              apiVersion={connectionQuery.data?.apiVersion ?? null}
              orgSettings={orgSettingsQuery.data ?? null}
              pushDisabledReason={
                apiTokenPresent
                  ? null
                  : 'Ask Sutton staff to generate JWT_TOKEN and place it in this organization’s app secrets.'
              }
              onPushComplete={() => activityQuery.refetch()}
            />
          </Box>
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: workspace === 'activity' ? 'flex' : 'none',
              flexDirection: 'column',
              overflow: 'hidden',
              p: { xs: 1.5, sm: 2 },
            }}
          >
            <ActivityLog query={activityQuery} />
          </Box>
        </Paper>
      ) : null}

      {showContent && !operable && isAdmin && organizationId && !loading ? (
        <Paper sx={{ p: { xs: 2, sm: 3 } }}>
          <SectionHeader
            overline="Connection"
            title={credentialsMissing ? 'Connection inactive' : 'Connect your account'}
            description={
              credentialsMissing
                ? 'Secrets are missing. Restore the ShipStation API key in Sutton and reload, then connect again.'
                : 'Validate credentials (V2 key, or V1 key plus secret) and sync carriers before pushing shipments.'
            }
          />
          <Box sx={{ mt: 2 }}>
            {credentialsMissing ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                The shipping queue stays hidden until ShipStation credentials are live again. Connect
                replaces any leftover connection record once the key is restored.
              </Typography>
            ) : !canOfferConnect ? (
              <Alert severity="warning">
                The app backend is unavailable right now, so Connect cannot verify your ShipStation
                API key. Use Retry on the error above, then try again.
              </Alert>
            ) : (
              <ConnectPanel
                shipStationKeyPresent={shipStationKeyPresent}
                mutating={mutating}
                onConnect={() => void connect()}
              />
            )}
          </Box>
        </Paper>
      ) : null}

      {showContent && !operable && !isAdmin && organizationId && !loading ? (
        <Paper sx={{ p: { xs: 2, sm: 3 } }}>
          <NonAdminNotice connected={operable} />
        </Paper>
      ) : null}

      <SetupCapabilitiesDialog
        open={setupCapabilitiesOpen}
        onClose={() => setSetupCapabilitiesOpen(false)}
        showSetup={Boolean(setupIncomplete && setupData && isAdmin)}
        setupItems={setupData?.items ?? []}
        featureStatus={featureStatusProps}
      />

      <Dialog open={settingsOpen} onClose={() => setSettingsOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>ShipStation settings</DialogTitle>
        <DialogContent>
          {draft && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <SettingField
                title={SETTING_HINTS.defaultFulfillmentMethod}
                label="Default fulfillment method"
              >
                <FormControl fullWidth>
                  <InputLabel id="fulfillment-label">Default fulfillment method</InputLabel>
                  <Select
                    labelId="fulfillment-label"
                    label="Default fulfillment method"
                    value={draft.defaultFulfillmentMethod}
                    onChange={(event) =>
                      setDraft({ ...draft, defaultFulfillmentMethod: event.target.value })
                    }
                  >
                    <MenuItem value="manual">Manual push</MenuItem>
                    <MenuItem value="scheduled">Scheduled push</MenuItem>
                  </Select>
                </FormControl>
              </SettingField>
              <SettingField title={SETTING_HINTS.defaultWeightOz} label="Default package weight">
                <TextField
                  label="Default weight (ounces)"
                  type="number"
                  value={draft.defaultWeightOz}
                  onChange={(event) => setDraft({ ...draft, defaultWeightOz: event.target.value })}
                  fullWidth
                  slotProps={{ htmlInput: { min: 0.1, step: 0.1 } }}
                />
              </SettingField>
              <SourceFilterField
                value={draft.sourceFilter}
                onChange={(sourceFilter) => setDraft({ ...draft, sourceFilter })}
                description={SETTING_HINTS.sourceFilter}
                skip={!settingsOpen}
              />
              {mutationError && <AppErrorAlert error={mutationError} />}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSettingsOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void saveSettings()}
            disabled={mutating || (draft != null && sourceFilterInvalid(draft.sourceFilter))}
          >
            {mutating ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogActions>
      </Dialog>

      <CarrierSettingsDialog
        open={carrierSettingsOpen}
        orgSettings={orgSettingsQuery.data}
        draft={carrierDraft ?? { defaults: {}, services: {} }}
        mutating={mutating}
        mutationError={mutationError}
        onPickDigitCarrierService={(digitOptionId, serviceKey) =>
          setCarrierDraft((current) => {
            // One Digit carrier resolves to one ShipStation service, so drop its other pins.
            const services = Object.fromEntries(
              Object.entries(current?.services ?? {}).map(([key, value]) => [
                key,
                value === digitOptionId ? '' : value,
              ]),
            );
            if (serviceKey) services[serviceKey] = digitOptionId;
            return { defaults: current?.defaults ?? {}, services };
          })
        }
        onClose={() => setCarrierSettingsOpen(false)}
        onSave={() => void saveCarrierMappings()}
      />
    </AppShell>
  );
}
