import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';

import { motionTransition } from './motion';
import StatusChip from './StatusChip';

export type ConnectionBarProps = {
  connected: boolean;
  /** Connection can call ShipStation (secrets present). */
  operable?: boolean;
  credentialsMissing?: boolean;
  apiVersion?: 'v1' | 'v2' | string | null;
  carrierCount?: number;
  loading: boolean;
  isAdmin: boolean;
  shipStationKeyPresent: boolean;
  setupProgress?: { present: number; total: number } | null;
  organizationId: string | null;
  notPublished: boolean;
  mutating: boolean;
  onConnect: () => void;
  onOpenSettings: () => void;
  onOpenCarrierSettings: () => void;
  onOpenSetupCapabilities: () => void;
  pushBlockedCarrierCount?: number;
};

function connectedLabel(apiVersion?: 'v1' | 'v2' | string | null) {
  if (apiVersion === 'v1') return 'Connected (V1)';
  if (apiVersion === 'v2') return 'Connected (V2)';
  return 'Connected';
}

export default function ConnectionBar({
  connected,
  operable = connected,
  credentialsMissing = false,
  apiVersion = null,
  carrierCount = 0,
  loading,
  isAdmin,
  shipStationKeyPresent,
  setupProgress,
  organizationId,
  notPublished,
  mutating,
  onConnect,
  onOpenSettings,
  onOpenCarrierSettings,
  onOpenSetupCapabilities,
  pushBlockedCarrierCount = 0,
}: ConnectionBarProps) {
  const carrierGapCount = pushBlockedCarrierCount;
  const carrierGapSummary =
    `${pushBlockedCarrierCount} Sutton shipping carrier${
      pushBlockedCarrierCount === 1 ? '' : 's'
    } cannot push until mapped to a ShipStation service`;
  const setupIncomplete =
    setupProgress != null && setupProgress.present < setupProgress.total;
  const ready = !loading && !notPublished && Boolean(organizationId);
  const adminActions = ready && isAdmin;

  const connectionStatus = loading ? (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <CircularProgress size={16} />
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Loading…
      </Typography>
    </Stack>
  ) : notPublished ? (
    <StatusChip color="error" label="Not published" />
  ) : !organizationId ? (
    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
      Open inside Sutton
    </Typography>
  ) : operable ? (
    <StatusChip
      label={connectedLabel(apiVersion)}
      color="success"
      sx={motionTransition('background-color, box-shadow', '0.3s')}
    />
  ) : credentialsMissing ? (
    <StatusChip color="warning" label="Not connected" />
  ) : isAdmin && !shipStationKeyPresent ? (
    <StatusChip color="warning" label="API key missing" />
  ) : (
    <StatusChip
      label="Not connected"
      sx={motionTransition('background-color, box-shadow', '0.3s')}
    />
  );

  return (
    <Box sx={{ width: '100%', mx: 'auto', px: { xs: 1.5, sm: 2 }, py: { xs: 1, sm: 1.5 } }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={{ xs: 1.5, md: 2 }}
        sx={{ alignItems: { md: 'center' }, justifyContent: 'space-between' }}
      >
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h1" component="h1" sx={{ fontSize: { xs: '1.35rem', sm: '1.5rem' } }}>
              ShipStation
            </Typography>
            {connectionStatus}
          </Stack>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {operable
              ? 'Create Sutton shipments, push from the shipping queue, then download the shipping label.'
              : credentialsMissing
                ? 'Connection inactive — restore ShipStation secrets in Sutton and reload.'
                : 'Connect ShipStation to sync carriers and push awaiting-carrier shipments for labels.'}
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {setupIncomplete ? (
            <StatusChip
              color="warning"
              label={`Setup ${setupProgress.present} of ${setupProgress.total}`}
              onClick={onOpenSetupCapabilities}
              sx={{ cursor: 'pointer' }}
            />
          ) : null}

          {ready ? (
            <Button
              variant="outlined"
              size="small"
              startIcon={<TuneOutlinedIcon />}
              onClick={onOpenSetupCapabilities}
            >
              Setup and capabilities
            </Button>
          ) : null}

          {adminActions && operable ? (
            <>
              <Tooltip
                title={
                  carrierGapCount > 0
                    ? carrierGapSummary
                    : `Map Sutton shipping carriers to ShipStation services (${carrierCount} carrier${
                        carrierCount === 1 ? '' : 's'
                      } synced)`
                }
              >
                <Button
                  variant="outlined"
                  size="small"
                  color={carrierGapCount > 0 ? 'error' : 'primary'}
                  startIcon={
                    carrierGapCount > 0 ? <ErrorOutlineIcon /> : <LocalShippingOutlinedIcon />
                  }
                  onClick={onOpenCarrierSettings}
                  aria-label={
                    carrierGapCount > 0 ? `Carrier configuration, ${carrierGapSummary}` : undefined
                  }
                >
                  {carrierGapCount > 0
                    ? `Carrier configuration (${carrierGapCount})`
                    : 'Carrier configuration'}
                </Button>
              </Tooltip>
              <Button
                variant="outlined"
                size="small"
                startIcon={<SettingsOutlinedIcon />}
                onClick={onOpenSettings}
              >
                Settings
              </Button>
            </>
          ) : null}

          {adminActions && !operable && !credentialsMissing && shipStationKeyPresent ? (
            <Button variant="contained" size="small" onClick={onConnect} disabled={mutating}>
              {mutating ? 'Connecting…' : 'Connect ShipStation'}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Box>
  );
}

export function ConnectPanel({
  shipStationKeyPresent,
  mutating,
  onConnect,
}: {
  shipStationKeyPresent: boolean;
  mutating: boolean;
  onConnect: () => void;
}) {
  if (!shipStationKeyPresent) {
    return (
      <Alert severity="warning">
        No ShipStation API key is configured for this organization. Add{' '}
        <strong>SHIPSTATION_API_KEY</strong> to this app’s secrets in Sutton (and{' '}
        <strong>SHIPSTATION_API_SECRET</strong> only if you use V1 Basic auth), then reload and
        connect.
      </Alert>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Connecting validates your credentials against ShipStation — API key alone is V2; key plus
        SHIPSTATION_API_SECRET is V1 — then syncs carriers. If a previous connection is still on
        file, Connect replaces it. Switching API versions the same way.
      </Typography>
      <Button variant="contained" onClick={onConnect} disabled={mutating} sx={{ alignSelf: 'flex-start' }}>
        {mutating ? 'Connecting…' : 'Connect ShipStation'}
      </Button>
    </Stack>
  );
}

export function NonAdminNotice({ connected }: { connected: boolean }) {
  return (
    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
      {connected
        ? 'Org admins manage connection and settings. You can work the shipping queue below.'
        : 'Org admins can connect ShipStation. App owners manage secrets in Sutton.'}
    </Typography>
  );
}
