import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';

import type { SetupItem } from '../setupTypes';
import { KeyNote } from './SecretQuickview';
import StatusChip from './StatusChip';

const SECRET_KEYS = ['API_TOKEN_SUTTON', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET'];

function KeyName({ children }: { children: string }) {
  return (
    <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace' }}>
      {children}
    </Typography>
  );
}

function checklistChip(item: SetupItem) {
  if (item.kind === 'env') {
    if (item.present && !item.valid) return <StatusChip color="error" label="Failed" />;
    if (item.present) return <StatusChip color="success" label="Variable set" />;
    if (item.required) return <StatusChip color="warning" label="Missing" />;
    return <StatusChip color="default" label="Not set" />;
  }
  if (item.present && !item.valid) return <StatusChip color="error" label="Failed" />;
  if (item.source === 'appDatabase' && item.present) {
    return <StatusChip color="success" label="Secret set (legacy)" />;
  }
  if (item.present) return <StatusChip color="success" label="Secret set" />;
  if (item.required) return <StatusChip color="warning" label="Missing" />;
  return null;
}

function SetupItemRow({ item, index }: { item: SetupItem; index: number }) {
  const env = item.kind === 'env';
  return (
    <Stack direction="row" spacing={2} sx={{ py: 2 }}>
      <Stack spacing={0.5} sx={{ alignItems: 'center', width: 32, flexShrink: 0 }}>
        {item.present ? (
          <CheckCircleOutlineIcon color="success" fontSize="small" />
        ) : (
          <RadioButtonUncheckedIcon sx={{ color: 'text.disabled' }} fontSize="small" />
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
          {index}
        </Typography>
      </Stack>
      <Stack spacing={1} sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" component="h3" sx={{ fontFamily: 'monospace' }}>
            {item.key}
          </Typography>
          {checklistChip(item)}
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {item.required ? 'Required' : 'Optional'} {env ? 'environment variable' : 'secret'}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {item.description}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Enables: {item.enables}
        </Typography>
        <KeyNote note={item.note} />
        {item.permissions?.length ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Required token permissions are listed under Secrets above.
          </Typography>
        ) : null}
        {!item.present ? (
          <Box
            sx={{
              alignSelf: 'flex-start',
              px: 1,
              py: 0.5,
              borderRadius: 999,
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="body2">
              {env ? 'Environment variable to add: ' : 'Secret key to add: '}
              <KeyName>{item.key}</KeyName>
            </Typography>
          </Box>
        ) : null}
      </Stack>
    </Stack>
  );
}

function Checklist({ label, items }: { label: string; items: SetupItem[] }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle1" component="h3">
        {label}
      </Typography>
      {items.map((item, index) => (
        <Box
          key={item.key}
          sx={{
            borderTop: index > 0 ? 1 : 0,
            borderColor: 'divider',
          }}
        >
          <SetupItemRow item={item} index={index + 1} />
        </Box>
      ))}
    </Stack>
  );
}

export default function SetupNeeded({ items }: { items: SetupItem[] }) {
  const secrets = items.filter((item) => item.kind !== 'env');
  const envItems = items.filter((item) => item.kind === 'env');

  return (
    <Stack spacing={2.5}>
      <Alert severity="info">
        Go to Settings in Sutton Studio and add to Secrets. Then click <strong>Save</strong> and
        reload this app. Sutton’s secret <em>values</em> are write-only — empty “Key name / Value”
        rows are only for adding new secrets. If a row below says <strong>Secret set</strong>, the
        app still has that key injected even when the edit form looks blank. Delete the named keys (
        {SECRET_KEYS.map((key, index) => (
          <span key={key}>
            {index > 0 ? ', ' : null}
            <KeyName>{key}</KeyName>
          </span>
        ))}
        ). Save, reload. If a key still shows set after a delete, republish the app so Sutton
        rebinds the runtime environment.
      </Alert>

      <Checklist label="Secrets" items={secrets} />

      {envItems.length > 0 ? (
        <>
          <Alert severity="info">
            Go to Settings in Sutton Studio and add to Environment variables, not Secrets. Then
            click <strong>Save</strong> and reload this app. These are plain configuration. A row
            that says <strong>Variable set</strong> is already injected. A row that says{' '}
            <strong>Not set</strong> is optional and can stay unset.
          </Alert>
          <Checklist label="Environment variables" items={envItems} />
        </>
      ) : null}
    </Stack>
  );
}
