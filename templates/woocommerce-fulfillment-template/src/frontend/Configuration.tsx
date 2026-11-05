import { useEffect, useMemo, useState } from 'react';

import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { AppErrorAlert, useBackendMutation, useBackendQuery, useApiQuery } from '@heysutton/sdk-react';

import PullFromWooCommerce from './components/PullFromWooCommerce';
import SectionHeader, { Subsection } from './components/SectionHeader';
import StatusChip from './components/StatusChip';
import type { AutoDeductStatus, FulfillmentConfig } from './types';

type WarehouseOption = {
  id: string;
  locationCode: string;
  description: string | null;
};

type WarehousePage = {
  warehouseLocations: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: WarehouseOption[];
  };
};

const WAREHOUSE_QUERY = `
  query WooCommerceWarehouses(
    $connection: ConnectionInput
    $search: String
    $status: WarehouseLocationStatus
    $types: [WarehouseLocationType!]
    $order: WarehouseLocationOrderInput
  ) {
    warehouseLocations(
      connection: $connection
      search: $search
      status: $status
      types: $types
      order: $order
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { id locationCode description }
    }
  }
`;

const PAGE_SIZE = 50;

function savedOption(config: FulfillmentConfig | undefined): WarehouseOption | null {
  if (!config?.warehouseLocationId) return null;
  return {
    id: config.warehouseLocationId,
    locationCode: config.warehouseLocationCode || 'Selected warehouse',
    description: null,
  };
}

function AutomatedDeductions({
  status,
  canToggle,
  mutating,
  breakerTripped,
  onSetEnabled,
}: {
  status: AutoDeductStatus | null | undefined;
  canToggle: boolean;
  mutating: boolean;
  breakerTripped: boolean;
  onSetEnabled: (enabled: boolean) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (!canToggle) return null;
  if (!status) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Loading automated deductions…
      </Typography>
    );
  }

  const handleSwitch = (next: boolean) => {
    if (next) setConfirmOpen(true);
    else onSetEnabled(false);
  };

  return (
    <Subsection
      title="Automated deductions"
      description="When on, each poll deducts stock for matched orders, including any already waiting at Pending approval, and marks those with enough stock fulfilled. Orders short on stock are retried each poll until fully covered. When off, they wait at Pending approval until someone approves them, and short orders are marked ready for Retry apply once restocked."
    >
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControlLabel
          sx={{ mr: 0, ml: 0 }}
          control={
            <Switch
              size="small"
              checked={status.enabled}
              disabled={mutating}
              slotProps={{ input: { 'aria-label': 'Automated deductions' } }}
              onChange={(_event, checked) => handleSwitch(checked)}
            />
          }
          label={status.enabled ? 'On' : 'Off'}
        />
        {breakerTripped ? (
          <StatusChip
            color="error"
            label="Auto-disabled — click to re-enable"
            onClick={() => onSetEnabled(true)}
            sx={{ cursor: 'pointer' }}
          />
        ) : null}
      </Stack>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Turn on automated inventory deductions?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            The scheduled poll (every 20 minutes) will deduct Sutton stock and mark each
            matched order with adequate stock fulfilled automatically. Orders already waiting at
            Pending approval are included, and a run starts as soon as you turn this on. An order
            short on any line deducts nothing; each poll rechecks its stock and deducts the whole
            order once every line is in stock. If
            {` ${status.threshold}`} orders in a row fail for any other reason, this turns
            itself back off automatically until an operator turns it on again.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setConfirmOpen(false);
              onSetEnabled(true);
            }}
          >
            Turn on
          </Button>
        </DialogActions>
      </Dialog>
    </Subsection>
  );
}

export default function Configuration({
  canEdit,
  onSaved,
  onPulled,
  autoDeduct,
}: {
  canEdit: boolean;
  onSaved: () => void;
  onPulled: () => void;
  autoDeduct: {
    status: AutoDeductStatus | null | undefined;
    canToggle: boolean;
    mutating: boolean;
    breakerTripped: boolean;
    onSetEnabled: (enabled: boolean) => void;
  };
}) {
  const configQuery = useBackendQuery<FulfillmentConfig>({ path: '/fulfillment/config' });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  // undefined follows the saved warehouse; null is an explicit clear; an object is a new pick.
  const [picked, setPicked] = useState<WarehouseOption | null | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  const [saveWarehouse, saveState] = useBackendMutation<FulfillmentConfig>();

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const locationsQuery = useApiQuery<WarehousePage>({
    query: WAREHOUSE_QUERY,
    skip: !canEdit,
    variables: {
      connection: { first: PAGE_SIZE },
      search: search || null,
      status: 'active',
      types: ['bin', 'workCenter', 'userDefined'],
      order: { by: 'locationCode', direction: 'asc' },
    },
  });

  const config = configQuery.data;
  const value = picked === undefined ? savedOption(config) : picked;
  const searched = locationsQuery.data?.warehouseLocations.nodes ?? [];
  const options = useMemo(() => {
    if (value && !searched.some((option) => option.id === value.id)) return [value, ...searched];
    return searched;
  }, [searched, value]);

  const unchanged =
    value != null &&
    value.id === config?.warehouseLocationId &&
    config?.warehouseLocationSource === 'selection' &&
    config.warehouseLocationConfigured === true;

  const handleSave = async () => {
    if (!value) return;
    const result = await saveWarehouse({
      path: '/fulfillment/warehouse',
      method: 'POST',
      body: { warehouseLocationId: value.id },
    });
    if (!result.ok) return;
    setPicked(undefined);
    setJustSaved(true);
    void configQuery.refetch();
    onSaved();
  };

  return (
    <Stack spacing={3} sx={{ maxWidth: 720, pt: 2 }}>
      <Box>
        <SectionHeader eyebrow="Fulfillment" title="Default location">
          Every item on a WooCommerce order deducts stock from the location you choose here.
        </SectionHeader>
        <Stack spacing={1.5}>
          {configQuery.error ? (
            <AppErrorAlert error={configQuery.error} onRetry={() => void configQuery.refetch()} />
          ) : null}

          {config?.warehouseLocationSource === 'secret' ? (
            <Alert severity="info">
              This location is still coming from the WAREHOUSE_LOCATION_ID secret. Save a selection
              here and fulfillment will use the Configuration tab from then on.
            </Alert>
          ) : null}

          {config && config.warehouseLocationId && config.warehouseLocationConfigured === false && !config.warehouseLocationError ? (
            <Alert severity="warning">
              The saved location isn't in Sutton. Choose another one. Applies
              stay blocked until then.
            </Alert>
          ) : null}

          {config?.warehouseLocationError ? (
            <Alert severity="warning">{config.warehouseLocationError}</Alert>
          ) : null}

          {justSaved ? <Alert severity="success">Location saved. New approvals deduct from this location.</Alert> : null}

          {canEdit ? (
            <Stack spacing={1.5}>
              {locationsQuery.error ? (
                <AppErrorAlert error={locationsQuery.error} onRetry={() => void locationsQuery.refetch()} />
              ) : null}
              <Autocomplete
                options={options}
                value={value}
                loading={locationsQuery.loading}
                filterOptions={(next) => next}
                isOptionEqualToValue={(option, selected) => option.id === selected.id}
                getOptionLabel={(option) => option.locationCode}
                noOptionsText={locationsQuery.loading ? 'Loading locations…' : 'No matching locations'}
                onChange={(_event, next) => {
                  setJustSaved(false);
                  setPicked(next);
                }}
                onInputChange={(_event, next, reason) => {
                  if (reason === 'input' || reason === 'clear') setSearchInput(next);
                }}
                renderOption={(props, option) => {
                  const { key, ...rest } = props;
                  return (
                    <li key={key} {...rest}>
                      <Box>
                        <Typography variant="body2">{option.locationCode}</Typography>
                        {option.description ? (
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                            {option.description}
                          </Typography>
                        ) : null}
                      </Box>
                    </li>
                  );
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Location"
                    placeholder="Search by location code"
                    helperText={
                      locationsQuery.data?.warehouseLocations.pageInfo.hasNextPage
                        ? `Showing the first ${PAGE_SIZE}. Type to narrow the list.`
                        : 'Active locations, sorted by location code.'
                    }
                  />
                )}
              />
              <Box>
                <Button
                  variant="contained"
                  disabled={!value || saveState.loading || unchanged}
                  onClick={() => void handleSave()}
                >
                  {saveState.loading ? 'Saving…' : 'Save location'}
                </Button>
              </Box>
              {saveState.error ? <AppErrorAlert error={saveState.error} /> : null}
            </Stack>
          ) : (
            <Stack spacing={0.5}>
              <Typography variant="subtitle1">
                {config?.warehouseLocationCode || (configQuery.loading ? 'Loading…' : 'No location selected')}
              </Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                Choosing the location needs permission to update orders or inventory.
              </Typography>
            </Stack>
          )}
        </Stack>
      </Box>

      <Divider />
      <Box>
        <SectionHeader eyebrow="Automation" title="WooCommerce automation" />
        <Stack spacing={2}>
          <AutomatedDeductions {...autoDeduct} />
          <PullFromWooCommerce onPulled={onPulled} />
        </Stack>
      </Box>
    </Stack>
  );
}
