import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

export default function SectionHeader({
  overline,
  title,
  description,
  action,
}: {
  overline?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      sx={{ alignItems: { sm: 'flex-start' }, justifyContent: 'space-between' }}
    >
      <Stack spacing={0.5} sx={{ minWidth: 0 }}>
        {overline ? (
          <Typography
            variant="overline"
            component="p"
            sx={{ color: 'primary.main', letterSpacing: '0.08em', lineHeight: 1.2 }}
          >
            {overline}
          </Typography>
        ) : null}
        <Typography variant="h2" component="h2">
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {description}
          </Typography>
        ) : null}
      </Stack>
      {action ? <Stack sx={{ flexShrink: 0 }}>{action}</Stack> : null}
    </Stack>
  );
}
