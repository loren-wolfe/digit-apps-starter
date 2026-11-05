import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import SyncIcon from '@mui/icons-material/Sync';

import { ALL_CARRIERS, ALL_PUSH } from '../queueFilters';

export type FacetOption = {
  value: string;
  label: string;
  count: number;
};

const tallySx = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '0.7rem',
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: 0,
} as const;

function FacetRail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={0.75} sx={{ alignItems: { sm: 'flex-start' } }}>
      <Typography
        variant="overline"
        component="div"
        sx={{
          width: { sm: 72 },
          flexShrink: 0,
          pt: { sm: 0.75 },
          color: 'text.secondary',
          lineHeight: 1.2,
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </Typography>
      <Stack
        direction="row"
        spacing={0.75}
        useFlexGap
        role="group"
        aria-label={label}
        sx={{ flexWrap: 'wrap', minWidth: 0 }}
      >
        {children}
      </Stack>
    </Stack>
  );
}

function FacetChoice({
  selected,
  label,
  count,
  onClick,
  ariaLabel,
}: {
  selected: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <Chip
      clickable
      size="small"
      color={selected ? 'primary' : 'default'}
      variant={selected ? 'filled' : 'outlined'}
      aria-pressed={selected}
      aria-label={ariaLabel}
      onClick={onClick}
      label={
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.75 }}>
          <span>{label}</span>
          {count != null ? (
            <Box component="span" sx={tallySx}>
              {count}
            </Box>
          ) : null}
        </Box>
      }
      sx={{
        height: 28,
        borderRadius: '4px',
        ...(!selected ? { bgcolor: 'background.paper' } : null),
        '& .MuiChip-label': { px: 1 },
      }}
    />
  );
}

export default function QueueFilterBar({
  search,
  onSearch,
  status,
  onStatus,
  statusOptions,
  carrier,
  onCarrier,
  carrierOptions,
  push,
  onPush,
  pushOptions,
  grouped,
  onGrouped,
  onPull,
  pulling,
  pullDisabled,
  shown,
  narrowed,
  onClear,
}: {
  search: string;
  onSearch: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  statusOptions: { value: string; label: string }[];
  carrier: string;
  onCarrier: (value: string) => void;
  carrierOptions: FacetOption[];
  push: string;
  onPush: (value: string) => void;
  pushOptions: FacetOption[];
  grouped: boolean;
  onGrouped: (grouped: boolean) => void;
  onPull: () => void;
  pulling: boolean;
  pullDisabled: boolean;
  shown: number;
  narrowed: boolean;
  onClear: () => void;
}) {
  const carrierTotal = carrierOptions.reduce((sum, option) => sum + option.count, 0);
  const pushTotal = pushOptions.reduce((sum, option) => sum + option.count, 0);

  return (
    <Stack spacing={1.25} sx={{ pb: 1.5, borderBottom: 1, borderColor: 'divider', flex: '0 0 auto' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
        <TextField
          size="small"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Sales order, tracking, or ShipStation id"
          aria-label="Find a shipment by carrier, sales order, shipping order, ShipStation id, or tracking number"
          fullWidth
          sx={{ flex: 1 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    aria-label="Clear search"
                    onClick={() => onSearch('')}
                    edge="end"
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            },
          }}
        />
        <Button
          variant="outlined"
          size="small"
          startIcon={<SyncIcon />}
          onClick={onPull}
          disabled={pulling || pullDisabled}
          sx={{ alignSelf: { xs: 'flex-start', sm: 'center' }, flexShrink: 0 }}
        >
          {pulling ? 'Pulling…' : 'Pull from ShipStation'}
        </Button>
      </Stack>
      <Typography variant="caption" sx={{ color: 'text.secondary', mt: -0.5 }}>
        Matches carrier, sales order, shipping order, ShipStation id, and tracking.
      </Typography>

      <FacetRail label="Sutton">
        {statusOptions.map((option) => (
          <FacetChoice
            key={option.value}
            selected={status === option.value}
            label={option.label}
            onClick={() => onStatus(status === option.value && option.value !== 'all' ? 'all' : option.value)}
          />
        ))}
      </FacetRail>

      {carrierOptions.length > 0 ? (
        <FacetRail label="Carrier">
          <FacetChoice
            selected={carrier === ALL_CARRIERS}
            label="All"
            count={carrierTotal}
            onClick={() => onCarrier(ALL_CARRIERS)}
          />
          {carrierOptions.map((option) => (
            <FacetChoice
              key={option.value}
              selected={carrier === option.value}
              label={option.label}
              count={option.count}
              onClick={() => onCarrier(carrier === option.value ? ALL_CARRIERS : option.value)}
            />
          ))}
        </FacetRail>
      ) : null}

      {pushOptions.length > 0 ? (
        <FacetRail label="Push">
          <FacetChoice
            selected={push === ALL_PUSH}
            label="All"
            count={pushTotal}
            onClick={() => onPush(ALL_PUSH)}
          />
          {pushOptions.map((option) => (
            <FacetChoice
              key={option.value}
              selected={push === option.value}
              label={option.label}
              count={option.count}
              onClick={() => onPush(push === option.value ? ALL_PUSH : option.value)}
            />
          ))}
          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              ml: { sm: 0.25 },
              pl: { sm: 1 },
              borderLeft: { sm: 1 },
              borderColor: 'divider',
            }}
          >
            <FacetChoice
              selected={grouped}
              label="Group rows"
              ariaLabel="Group the queue by push status"
              onClick={() => onGrouped(!grouped)}
            />
          </Box>
        </FacetRail>
      ) : null}

      {narrowed && shown > 0 ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {shown} shipment{shown === 1 ? '' : 's'}
          </Typography>
          <Button size="small" onClick={onClear}>
            Clear filters
          </Button>
        </Stack>
      ) : null}
    </Stack>
  );
}
