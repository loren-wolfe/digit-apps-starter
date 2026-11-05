import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import FeatureStatus, { type FeatureStatusProps } from './FeatureStatus';
import SecretQuickview, { EnvQuickview } from './SecretQuickview';
import SetupNeeded from './SetupNeeded';
import type { SetupItem } from '../setupTypes';

export default function SetupCapabilitiesDialog({
  open,
  onClose,
  showSetup,
  items,
  featureStatus,
}: {
  open: boolean;
  onClose: () => void;
  showSetup: boolean;
  items: SetupItem[];
  featureStatus: FeatureStatusProps;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      scroll="paper"
      keepMounted
      aria-labelledby="setup-capabilities-title"
    >
      <DialogTitle id="setup-capabilities-title">Secrets and capabilities</DialogTitle>
      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 }, py: 3 }}>
        <Stack spacing={3}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Add credentials under Secrets and plain configuration under Environment variables.
            Warehouse, the WooCommerce poll, and automated deductions stay on the Configuration tab.
          </Typography>
          <SecretQuickview items={items} />
          <EnvQuickview items={items} />
          {showSetup ? (
            <Box>
              <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.08em' }}>
                Setup
              </Typography>
              <Typography variant="h3" component="h3" sx={{ mt: 0.5, mb: 2 }}>
                Finish setup
              </Typography>
              <SetupNeeded items={items} />
            </Box>
          ) : null}
          <Divider />
          <FeatureStatus {...featureStatus} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
