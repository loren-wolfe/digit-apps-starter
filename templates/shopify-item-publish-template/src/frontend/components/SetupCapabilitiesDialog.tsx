import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import FeatureStatus from './FeatureStatus';
import SetupNeeded from './SetupNeeded';
import type { SetupData } from '../setupTypes';

export default function SetupCapabilitiesDialog({
  open,
  onClose,
  setup,
  showSetup,
}: {
  open: boolean;
  onClose: () => void;
  setup: SetupData | undefined;
  showSetup: boolean;
}) {
  const items = setup?.items ?? [];

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="setup-capabilities-title">
      <DialogTitle id="setup-capabilities-title">Setup and capabilities</DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 3 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
          Configure Sutton app secrets, then see what works for this Shopify connection.
        </Typography>
        <Stack spacing={3}>
          {showSetup ? (
            <Stack spacing={1}>
              <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.08em' }}>
                Setup
              </Typography>
              <Typography variant="h3" component="h3">
                Finish setup
              </Typography>
              <SetupNeeded items={items} />
            </Stack>
          ) : null}
          {showSetup ? <Divider /> : null}
          <FeatureStatus items={items} stores={setup?.stores ?? []} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
