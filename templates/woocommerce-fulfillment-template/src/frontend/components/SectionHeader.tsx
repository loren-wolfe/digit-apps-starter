import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

/** Shared heading block for Configuration sections: eyebrow, title, then a short description. */
export default function SectionHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <Stack spacing={0.5} sx={{ mb: 1.5 }}>
      <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.08em', lineHeight: 1.5 }}>
        {eyebrow}
      </Typography>
      <Typography variant="h3" component="h2">
        {title}
      </Typography>
      {children ? (
        <Typography variant="body2" component="div" sx={{ color: 'text.secondary' }}>
          {children}
        </Typography>
      ) : null}
    </Stack>
  );
}

/** An outlined part of a Configuration section: title and short description, then its controls. */
export function Subsection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Box component="section" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Stack spacing={0.5} sx={{ mb: children ? 1.5 : 0 }}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" component="div" sx={{ color: 'text.secondary' }}>
            {description}
          </Typography>
        ) : null}
      </Stack>
      {children}
    </Box>
  );
}
