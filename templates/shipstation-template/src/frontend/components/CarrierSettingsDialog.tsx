import { useMemo } from 'react';

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import ListSubheader from '@mui/material/ListSubheader';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import { AppErrorAlert, type AppError } from '@heysutton/sdk-react';

import StatusChip from './StatusChip';

import type {
  CarrierDraft,
  DigitCarrierMapRow,
  DigitCarrierOption,
  OrgSettingsData,
} from '../carrierTypes';
import { digitCarrierStatusCopy, serviceDraftKey } from '../carrierTypes';

/** One selectable ShipStation service across the whole catalog, for the Digit-first view. */
type ServiceChoice = {
  key: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
};

function DigitCarrierRows({
  digitCarriers,
  digitCarrierMaps,
  draft,
  serviceChoices,
  disabled,
  onPickService,
}: {
  digitCarriers: DigitCarrierOption[];
  digitCarrierMaps: DigitCarrierMapRow[];
  draft: CarrierDraft;
  serviceChoices: ServiceChoice[];
  disabled: boolean;
  onPickService: (digitOptionId: string, serviceKey: string) => void;
}) {
  const savedByOption = new Map(digitCarrierMaps.map((row) => [row.digitOptionId, row]));
  const byCarrier: { carrierName: string; choices: ServiceChoice[] }[] = [];
  for (const choice of serviceChoices) {
    const group = byCarrier.find((row) => row.carrierName === choice.carrierName);
    if (group) group.choices.push(choice);
    else byCarrier.push({ carrierName: choice.carrierName, choices: [choice] });
  }

  return (
    <TableContainer>
      <Table size="small" sx={{ '& td, & th': { py: 0.75 } }}>
        <TableHead>
          <TableRow>
            <TableCell>Sutton shipping carrier</TableCell>
            <TableCell sx={{ width: '46%' }}>ShipStation service used on push</TableCell>
            <TableCell align="right">Push</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {digitCarriers.map((option) => {
            const pinned = Object.entries(draft.services)
              .filter(([, value]) => value === option.id)
              .map(([key]) => key);
            const saved = savedByOption.get(option.id);
            const status =
              pinned.length > 1
                ? digitCarrierStatusCopy('ambiguous')
                : pinned.length === 1
                  ? digitCarrierStatusCopy('ok')
                  : digitCarrierStatusCopy(saved?.status === 'unconfirmed' ? 'unconfirmed' : 'unmapped');
            const autoHint =
              pinned.length === 0 && saved?.status === 'unconfirmed' && saved.ssServiceName
                ? `Auto-matched to ${saved.ssServiceName}`
                : 'Not mapped';
            return (
              <TableRow key={option.id} hover>
                <TableCell>
                  <Typography variant="body2">{option.value}</Typography>
                </TableCell>
                <TableCell>
                  <Select
                    size="small"
                    fullWidth
                    displayEmpty
                    disabled={disabled}
                    value={pinned.length === 1 ? pinned[0] : ''}
                    onChange={(event) => onPickService(option.id, event.target.value)}
                    inputProps={{ 'aria-label': `ShipStation service for ${option.value}` }}
                    renderValue={(selected) => {
                      const choice = serviceChoices.find((row) => row.key === selected);
                      if (choice) return `${choice.carrierName} · ${choice.serviceName}`;
                      if (pinned.length > 1) return 'Mapped to several services';
                      return (
                        <Typography component="span" variant="body2" sx={{ color: 'text.disabled' }}>
                          {autoHint}
                        </Typography>
                      );
                    }}
                  >
                    <MenuItem value="">Not mapped</MenuItem>
                    {byCarrier.flatMap((group) => [
                      <ListSubheader key={`head-${group.carrierName}`}>
                        {group.carrierName}
                      </ListSubheader>,
                      ...group.choices.map((choice) => (
                        <MenuItem key={choice.key} value={choice.key}>
                          {choice.serviceName}
                        </MenuItem>
                      )),
                    ])}
                  </Select>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title={status.hint}>
                    <StatusChip color={status.color} label={status.label} />
                  </Tooltip>
                </TableCell>
              </TableRow>
            );
          })}
          {digitCarriers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  This organization has no Sutton shipping carriers yet. Add them in Sutton under
                  shipping carriers, then reopen this dialog.
                </Typography>
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default function CarrierSettingsDialog({
  open,
  orgSettings,
  draft,
  mutating,
  mutationError,
  onPickDigitCarrierService,
  onClose,
  onSave,
}: {
  open: boolean;
  orgSettings: OrgSettingsData | undefined;
  draft: CarrierDraft;
  mutating: boolean;
  mutationError: AppError | null;
  onPickDigitCarrierService: (digitOptionId: string, serviceKey: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const digitCarriers = orgSettings?.digitCarriers ?? [];
  const digitCarrierMaps = orgSettings?.digitCarrierMaps ?? [];
  const loadError = orgSettings?.digitCarriersError;
  const carriers = orgSettings?.ssCarriers ?? [];

  const serviceChoices = useMemo<ServiceChoice[]>(() => {
    const out: ServiceChoice[] = [];
    for (const carrier of carriers) {
      for (const service of carrier.services ?? []) {
        if (!service.serviceCode) continue;
        out.push({
          key: serviceDraftKey(carrier.carrierCode, service.serviceCode),
          carrierName: carrier.name || carrier.carrierCode,
          serviceCode: service.serviceCode,
          serviceName: service.name || service.serviceCode,
        });
      }
    }
    return out;
  }, [carriers]);

  const pushReadyCount = digitCarriers.filter((option) =>
    Object.values(draft.services).filter((value) => value === option.id).length === 1,
  ).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      scroll="paper"
      aria-labelledby="carrier-settings-title"
    >
      <DialogTitle id="carrier-settings-title" sx={{ pb: 1 }}>
        Carrier configuration · {pushReadyCount}/{digitCarriers.length} ready
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Stack spacing={1.5} sx={{ p: 2 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Pick the ShipStation service to use when each Sutton shipping carrier is pushed. A
            carrier with no service blocks its shipments in the queue. Auto-matched services must
            be confirmed here before they can push.
          </Typography>
          {loadError ? <Alert severity="warning">{loadError}</Alert> : null}
          {mutationError ? <AppErrorAlert error={mutationError} /> : null}
        </Stack>
        <DigitCarrierRows
          digitCarriers={digitCarriers}
          digitCarrierMaps={digitCarrierMaps}
          draft={draft}
          serviceChoices={serviceChoices}
          disabled={Boolean(loadError)}
          onPickService={onPickDigitCarrierService}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={onSave} disabled={mutating || Boolean(loadError)}>
          {mutating ? 'Saving…' : 'Save mapping'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
