import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import type { ReactNode } from 'react';

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100%', bgcolor: 'background.default' }}>
      <Stack
        spacing={2}
        sx={{
          width: '100%',
          maxWidth: 980,
          mx: 'auto',
          px: { xs: 2, sm: 3 },
          py: { xs: 2, sm: 3 },
        }}
      >
        {children}
      </Stack>
    </Box>
  );
}
