import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import type { ReactNode } from 'react';

export default function AppShell({
  commandBar,
  children,
}: {
  commandBar: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        height: '100vh',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          flex: '0 0 auto',
          zIndex: 10,
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {commandBar}
      </Box>
      <Stack
        spacing={2}
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          mx: 'auto',
          px: { xs: 1.5, sm: 2 },
          py: { xs: 1.5, sm: 2 },
          overflow: 'hidden',
        }}
      >
        {children}
      </Stack>
    </Box>
  );
}
