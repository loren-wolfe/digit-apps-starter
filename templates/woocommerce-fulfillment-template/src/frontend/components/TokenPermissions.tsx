import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import type { SetupItem } from '../setupTypes';

type Permission = NonNullable<SetupItem['permissions']>[number];

function PermissionGroup({ title, permissions }: { title: string; permissions: Permission[] }) {
  if (permissions.length === 0) return null;
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700 }}>
        {title}
      </Typography>
      <Box
        component="ul"
        sx={{ m: 0, pl: 2, display: 'grid', gap: 0.25, '& li': { color: 'text.secondary' } }}
      >
        {permissions.map((permission) => (
          <li key={permission.key}>
            <Typography variant="caption" component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>
              {permission.label}
            </Typography>
            <Typography variant="caption" component="span">
              {' '}
              — {permission.use}
            </Typography>
          </li>
        ))}
      </Box>
    </Stack>
  );
}

/** Lists the Sutton API token permissions a secret needs, split into read and write access. */
export default function TokenPermissions({ item }: { item: SetupItem }) {
  const permissions = item.permissions ?? [];
  if (permissions.length === 0) return null;
  const reads = permissions.filter((permission) => permission.key.startsWith('READ_'));
  const writes = permissions.filter((permission) => !permission.key.startsWith('READ_'));

  return (
    <Stack spacing={1} sx={{ pt: 0.5 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        The token needs these permissions in Sutton:
      </Typography>
      <PermissionGroup title="Read" permissions={reads} />
      <PermissionGroup title="Write" permissions={writes} />
    </Stack>
  );
}
