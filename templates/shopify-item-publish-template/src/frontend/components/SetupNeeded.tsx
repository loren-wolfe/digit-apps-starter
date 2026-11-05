import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';

import type { SetupItem } from '../setupTypes';
import { SecretPresenceChip } from './StatusChip';

function SetupItemRow({ item, index }: { item: SetupItem; index: number }) {
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
          <SecretPresenceChip item={item} />
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {item.description}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Enables: {item.enables}
        </Typography>
      </Stack>
    </Stack>
  );
}

export default function SetupNeeded({ items }: { items: SetupItem[] }) {
  const required = items.filter((item) => item.required);
  const presentCount = required.filter((item) => item.present && item.valid).length;

  return (
    <Stack spacing={2.5}>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Setup checklist ({presentCount} of {required.length})
      </Typography>
      <Stack spacing={0}>
        {items.map((item, index) => (
          <Box key={item.key} sx={{ borderTop: index > 0 ? 1 : 0, borderColor: 'divider' }}>
            <SetupItemRow item={item} index={index + 1} />
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
