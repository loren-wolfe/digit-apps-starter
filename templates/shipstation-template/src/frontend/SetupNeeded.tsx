import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';

import ApiModeToggle, { type ApiModeChoice } from './components/ApiModeToggle';
import StatusChip from './components/StatusChip';
import type { SetupItem } from './setupTypes';

const TOKEN_KEY = 'JWT_TOKEN';
const SHIPSTATION_KEY = 'SHIPSTATION_API_KEY';
const SHIPSTATION_SECRET = 'SHIPSTATION_API_SECRET';

const SHARED_KEYS = new Set([SHIPSTATION_KEY, TOKEN_KEY]);

type SetupNeededProps = {
  items: SetupItem[];
};

function fieldLabel(item: SetupItem) {
  if (item.key === TOKEN_KEY) return 'Sutton JWT (staff-generated)';
  if (item.key === SHIPSTATION_KEY) return 'ShipStation API key';
  if (item.key === SHIPSTATION_SECRET) return 'ShipStation API secret (V1)';
  return item.key;
}

function statusChip({ item }: { item: SetupItem }) {
  if (item.present && !item.valid) {
    return <StatusChip color="error" label="Failed" />;
  }
  if (item.present) {
    return (
      <StatusChip
        color="success"
        label={item.source === 'appDatabase' ? 'Secret set (legacy)' : 'Secret set'}
      />
    );
  }
  return <StatusChip color="warning" label="Missing" />;
}

function SetupItemRow({
  item,
  index,
  showIndex,
}: {
  item: SetupItem;
  index: number;
  showIndex: boolean;
}) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 2 }}>
      <Stack spacing={0.5} sx={{ alignItems: 'center', width: 32, flexShrink: 0 }}>
        {item.present ? (
          <CheckCircleOutlineIcon color="success" fontSize="small" />
        ) : (
          <RadioButtonUncheckedIcon sx={{ color: 'text.disabled' }} fontSize="small" />
        )}
        {showIndex ? (
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
            {index}
          </Typography>
        ) : null}
      </Stack>
      <Stack spacing={1} sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" component="h3">
            {fieldLabel(item)}
          </Typography>
          {statusChip({ item })}
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {item.description}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Enables: {item.enables}
        </Typography>
        {!item.present ? (
          <Box
            sx={{
              display: 'inline-flex',
              alignSelf: 'flex-start',
              px: 1,
              py: 0.5,
              borderRadius: 1,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="body2" sx={{ color: 'warning.main' }}>
              Secret key to add:{' '}
              <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
                {item.key}
              </Typography>
            </Typography>
          </Box>
        ) : null}
      </Stack>
    </Stack>
  );
}

function ItemList({
  items,
  numberFrom = 1,
  showIndex,
}: {
  items: SetupItem[];
  numberFrom?: number;
  showIndex: boolean;
}) {
  return (
    <Stack spacing={0}>
      {items.map((item, i) => (
        <Box
          key={item.key}
          sx={{
            borderTop: i > 0 ? 1 : 0,
            borderColor: 'divider',
          }}
        >
          <SetupItemRow item={item} index={numberFrom + i} showIndex={showIndex} />
        </Box>
      ))}
    </Stack>
  );
}

export default function SetupNeeded({ items }: SetupNeededProps) {
  const v1Secret = items.find((item) => item.key === SHIPSTATION_SECRET);
  const keyPresent = Boolean(items.find((item) => item.key === SHIPSTATION_KEY)?.present);
  const choosingV1 = Boolean(v1Secret?.present);

  const [viewedMode, setViewedMode] = useState<ApiModeChoice>(choosingV1 ? 'v1' : 'v2');

  const sharedItems = items.filter((item) => SHARED_KEYS.has(item.key));
  const v1OnlyItems = [v1Secret].filter(Boolean) as SetupItem[];
  const visibleItems =
    viewedMode === 'v1' ? [...sharedItems, ...v1OnlyItems] : [...sharedItems];

  const progressRequired = items.filter((item) => item.required);
  const presentCount = progressRequired.filter((item) => item.present).length;

  return (
    <Stack spacing={2.5}>
      <Alert severity="info">
        These are this organization’s app secrets in Sutton. Add or remove them under Manage Custom
        Apps → Edit for this integration, then click <strong>Save</strong> and reload this app.
        Sutton’s secret <em>values</em> are write-only — empty “Key name / Value” rows are only for
        adding new secrets. If a row below says <strong>Secret set</strong>, the Worker still has
        that key injected even when the edit form looks blank. Delete the named keys (
        <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
          SHIPSTATION_API_KEY
        </Typography>
        ,{' '}
        <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
          SHIPSTATION_API_SECRET
        </Typography>
        ,{' '}
        <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
          JWT_TOKEN
        </Typography>
        ). Sutton staff generate JWT_TOKEN and place it on this account — do not use a
        Settings → API Tokens <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
          da_
        </Typography>{' '}
        token. Save, reload. If it still shows set after a delete, republish the app so Sutton
        rebinds Worker env.
      </Alert>

      <Alert severity="warning" variant="outlined">
        ShipStation is <strong>V1 or V2</strong>, not both. Use the toggle to see which secrets each
        mode needs. Leave{' '}
        <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
          SHIPSTATION_API_SECRET
        </Typography>{' '}
        unset for V2 (API key alone). Set the secret for V1 Basic auth. After changing mode,
        disconnect and reconnect.
        {choosingV1
          ? ' Secrets currently resolve to V1.'
          : keyPresent
            ? ' Secrets currently resolve to V2.'
            : ' No ShipStation API key yet.'}
      </Alert>

      <Stack
        direction="row"
        spacing={1.5}
        useFlexGap
        sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Setup checklist for {viewedMode === 'v1' ? 'V1' : 'V2'} ({presentCount} of{' '}
          {progressRequired.length})
        </Typography>
        <ApiModeToggle value={viewedMode} onChange={setViewedMode} />
      </Stack>

      {viewedMode === 'v2' ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          V2 uses the API key alone — leave{' '}
          <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
            SHIPSTATION_API_SECRET
          </Typography>{' '}
          unset.
        </Typography>
      ) : (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          V1 needs the API key plus API secret for Basic auth.
        </Typography>
      )}

      <ItemList items={visibleItems} numberFrom={1} showIndex />
    </Stack>
  );
}
