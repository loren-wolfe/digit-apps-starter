import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import type { SetupItem } from '../setupTypes';
import StatusChip from './StatusChip';
import TokenPermissions from './TokenPermissions';

type ChipSpec = {
  label: string;
  color: 'success' | 'warning' | 'error' | 'default';
};

/** Quickview status. Optional secrets that are absent stay off the list; optional env vars show as Not set. */
export function quickviewChip(item: SetupItem): ChipSpec | null {
  if (item.present && !item.valid) return { label: 'Failed', color: 'error' };
  if (item.kind === 'env') {
    if (item.present && item.valid) return { label: 'Variable set', color: 'success' };
    if (item.required && !item.present) return { label: 'Missing', color: 'warning' };
    return { label: 'Not set', color: 'default' };
  }
  if (item.source === 'appDatabase' && item.present) {
    return { label: 'Secret set (legacy)', color: 'success' };
  }
  if (item.present && item.valid) return { label: 'Secret set', color: 'success' };
  if (item.required && !item.present) return { label: 'Missing', color: 'warning' };
  return null;
}

export function KeyNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      <InfoOutlinedIcon sx={{ fontSize: 16, color: 'warning.main' }} />
      <Typography variant="caption" sx={{ color: 'text.primary', fontWeight: 600 }}>
        {note}
      </Typography>
    </Stack>
  );
}

function KeyList({ items, showDescription = false }: { items: SetupItem[]; showDescription?: boolean }) {
  const rows = items.flatMap((item) => {
    const chip = quickviewChip(item);
    return chip ? [{ item, chip }] : [];
  });

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1}>
        {rows.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            None
          </Typography>
        ) : (
          rows.map(({ item, chip }) => (
            <Stack key={item.key} spacing={0.25}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {item.key}
                  {item.required ? null : (
                    <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 1, fontFamily: 'inherit' }}>
                      optional
                    </Typography>
                  )}
                </Typography>
                <StatusChip color={chip.color} label={chip.label} />
              </Stack>
              {showDescription ? (
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {item.description}
                </Typography>
              ) : null}
              <KeyNote note={item.note} />
              <TokenPermissions item={item} />
            </Stack>
          ))
        )}
      </Stack>
    </Paper>
  );
}

function requiredSetCount(items: SetupItem[]) {
  const required = items.filter((item) => item.required);
  const setCount = required.filter((item) => item.present && item.valid).length;
  return { setCount, requiredTotal: required.length };
}

export default function SecretQuickview({ items }: { items: SetupItem[] }) {
  const secrets = items.filter((item) => item.kind !== 'env');
  const { setCount, requiredTotal } = requiredSetCount(secrets);

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.08em' }}>
          Secrets
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Credentials. Add these under Secrets in Sutton Studio.
        </Typography>
        <Typography variant="body2">
          {setCount} of {requiredTotal} required secrets set
        </Typography>
      </Stack>
      <KeyList items={secrets} />
    </Stack>
  );
}

export function EnvQuickview({ items }: { items: SetupItem[] }) {
  const envItems = items.filter((item) => item.kind === 'env');
  if (envItems.length === 0) return null;
  const { setCount, requiredTotal } = requiredSetCount(envItems);

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.08em' }}>
          Environment variables
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Plain configuration, not credentials. Add these under Environment variables in Sutton Studio.
        </Typography>
        <Typography variant="body2">
          {requiredTotal === 0
            ? 'No required environment variables.'
            : `${setCount} of ${requiredTotal} required environment variables set`}
        </Typography>
      </Stack>
      <KeyList items={envItems} showDescription />
    </Stack>
  );
}
