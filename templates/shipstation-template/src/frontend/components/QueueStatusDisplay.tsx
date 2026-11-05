import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';

import { MANUAL_PUSH_RETRY_MEANING, type QueuePushDisplay } from '../eligibility';
import StatusChip from './StatusChip';

export const statusTooltipSlotProps = {
  tooltip: {
    sx: {
      maxWidth: 360,
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
} as const;

export default function QueueStatusDisplay({ pushDisplay }: { pushDisplay: QueuePushDisplay }) {
  const chip = (
    <Tooltip
      title={pushDisplay.tooltip}
      enterDelay={200}
      enterTouchDelay={0}
      slotProps={statusTooltipSlotProps}
    >
      <StatusChip color={pushDisplay.chipColor} label={pushDisplay.primary} />
    </Tooltip>
  );
  if (!pushDisplay.manualRetry) return chip;
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      {chip}
      <Tooltip
        title={MANUAL_PUSH_RETRY_MEANING}
        enterDelay={200}
        enterTouchDelay={0}
        slotProps={statusTooltipSlotProps}
      >
        <InfoOutlinedIcon
          fontSize="small"
          color="info"
          tabIndex={0}
          aria-label={MANUAL_PUSH_RETRY_MEANING}
          sx={{ cursor: 'help', outline: 'none' }}
        />
      </Tooltip>
    </Stack>
  );
}
