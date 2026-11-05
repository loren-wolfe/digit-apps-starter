import { useState } from 'react';

import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';

import { AppErrorAlert, useBackendQuery, useApiQuery } from '@heysutton/sdk-react';

import AppShell from './AppShell';
import SetupCapabilitiesDialog from './components/SetupCapabilitiesDialog';
import StatusChip from './components/StatusChip';
import Publisher from './Publisher';
import type { SetupData } from './setupTypes';

type BootstrapData = {
  organization?: { id: string } | null;
};

const BOOTSTRAP_QUERY = `
  query ShopifyItemPublishBootstrap {
    organization { id }
  }
`;

export default function App() {
  const [open, setOpen] = useState(false);
  const setupQuery = useBackendQuery<SetupData>({ path: '/setup' });
  const bootstrap = useApiQuery<BootstrapData>({ query: BOOTSTRAP_QUERY });
  const setup = setupQuery.data;
  const items = setup?.items ?? [];
  const required = items.filter((item) => item.required);
  const presentRequired = required.filter((item) => item.present && item.valid).length;
  const setupIncomplete = required.length > 0 && presentRequired < required.length;
  const organizationId = bootstrap.data?.organization?.id ?? null;
  const shellLoading = setupQuery.loading || bootstrap.loading;
  const shellReady = !shellLoading && Boolean(setup?.usable) && Boolean(organizationId);
  const showFinishSetup = Boolean(setup);

  return (
    <AppShell>
      {shellReady ? (
        <Stack direction="row" spacing={1} useFlexGap sx={{ justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          {setupIncomplete ? (
            <StatusChip
              color="warning"
              label={`Setup ${presentRequired} of ${required.length}`}
              onClick={() => setOpen(true)}
              sx={{ cursor: 'pointer' }}
            />
          ) : null}
          <Button size="small" variant="outlined" startIcon={<TuneOutlinedIcon />} onClick={() => setOpen(true)}>
            Setup and capabilities
          </Button>
        </Stack>
      ) : null}
      {setupQuery.error ? <AppErrorAlert error={setupQuery.error} onRetry={() => void setupQuery.refetch()} /> : null}
      {bootstrap.error ? <AppErrorAlert error={bootstrap.error} onRetry={() => void bootstrap.refetch()} /> : null}
      <Publisher
        setupStores={setup?.stores ?? []}
        setupKnown={Boolean(setup)}
        suttonTokenPresent={items.some((item) => item.key === 'API_TOKEN_SUTTON' && item.present && item.valid)}
        onOpenSetup={() => setOpen(true)}
      />
      <SetupCapabilitiesDialog open={open} onClose={() => setOpen(false)} setup={setup} showSetup={showFinishSetup} />
    </AppShell>
  );
}
