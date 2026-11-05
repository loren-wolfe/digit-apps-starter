import { forwardRef } from 'react';

import Chip from '@mui/material/Chip';
import { alpha } from '@mui/material/styles';
import type { ChipProps } from '@mui/material/Chip';

import type { SetupItem } from '../setupTypes';

const StatusChip = forwardRef<HTMLDivElement, ChipProps>(function StatusChip(
  { color = 'default', label, onClick, sx, ...rest },
  ref,
) {
  return (
    <Chip
      ref={ref}
      size="small"
      variant="filled"
      color={color}
      label={label}
      onClick={onClick}
      {...rest}
      sx={[
        (theme) => {
          const semantic = color && color !== 'default' ? theme.palette[color] : null;
          const bg = semantic?.main ?? theme.palette.background.paper;
          const fg = semantic
            ? theme.palette.getContrastText(semantic.main)
            : theme.palette.text.primary;
          return {
            height: 24,
            maxWidth: 220,
            fontWeight: 700,
            letterSpacing: '0.02em',
            bgcolor: bg,
            color: fg,
            border: 0,
            boxShadow: `inset 0 0 0 1px ${alpha(fg, 0.12)}`,
            '& .MuiChip-label': {
              px: 1,
              fontSize: '0.75rem',
              lineHeight: 1.25,
              fontWeight: 700,
              color: fg,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          };
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    />
  );
});

export default StatusChip;

export function SecretPresenceChip({
  item,
}: {
  item: Pick<SetupItem, 'present' | 'valid' | 'source'>;
}) {
  if (item.present && !item.valid) return <StatusChip color="error" label="Failed" />;
  if (item.source === 'appDatabase' && item.present) {
    return <StatusChip color="success" label="Secret set (legacy)" />;
  }
  if (item.present) return <StatusChip color="success" label="Secret set" />;
  return <StatusChip color="warning" label="Missing" />;
}
