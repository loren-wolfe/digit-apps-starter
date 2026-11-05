import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import FeatureStatus, { type FeatureStatusProps } from '../FeatureStatus';
import SetupNeeded from '../SetupNeeded';
import type { SetupItem } from '../setupTypes';

export default function SetupCapabilitiesDialog({
  open,
  onClose,
  showSetup,
  setupItems,
  featureStatus,
}: {
  open: boolean;
  onClose: () => void;
  showSetup: boolean;
  setupItems: SetupItem[];
  featureStatus: FeatureStatusProps;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      scroll="paper"
      aria-labelledby="setup-capabilities-title"
    >
      <DialogTitle id="setup-capabilities-title">Setup and capabilities</DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 3 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
          Configure Sutton app secrets, then see what works for the active ShipStation mode (V1 or
          V2 — never both).
        </Typography>
        <Stack spacing={3}>
          {showSetup ? (
            <Box>
              <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.08em' }}>
                Setup
              </Typography>
              <Typography variant="h3" component="h3" sx={{ mt: 0.5, mb: 2 }}>
                Finish setup
              </Typography>
              <SetupNeeded items={setupItems} />
            </Box>
          ) : null}
          {showSetup ? <Divider /> : null}
          <FeatureStatus {...featureStatus} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
