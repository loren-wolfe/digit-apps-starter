import { useMemo } from 'react';

import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import { useApiQuery } from '@heysutton/sdk-react';

import {
  isCommerceConnection,
  MANUAL_SOURCE,
  MANUAL_SOURCE_LABEL,
  sourceLabel,
  type SourceConnection,
  type SourceFilterSettings,
} from '../sourceFilter';

const SOURCE_CONNECTIONS_QUERY = `
  query ShipStationSourceConnections {
    rutterConnections(connection: { first: 100 }) {
      nodes { id platform storeUniqueName status }
    }
  }
`;

type SourceConnectionsData = {
  rutterConnections?: { nodes?: (SourceConnection & { id: string })[] | null } | null;
};

export function sourceFilterInvalid(value: SourceFilterSettings) {
  return value.enabled && value.keys.length === 0;
}

/**
 * Hidden when the org has no commerce integration, matching the optional Source column on the
 * Sutton sales order table.
 */
export default function SourceFilterField({
  value,
  onChange,
  description,
  skip = false,
}: {
  value: SourceFilterSettings;
  onChange: (next: SourceFilterSettings) => void;
  description: string;
  skip?: boolean;
}) {
  const connectionsQuery = useApiQuery<SourceConnectionsData>({
    query: SOURCE_CONNECTIONS_QUERY,
    skip,
  });

  const options = useMemo(() => {
    const commerce = (connectionsQuery.data?.rutterConnections?.nodes ?? [])
      .filter((connection) => connection?.id && isCommerceConnection(connection))
      .map((connection) => ({ key: connection.id, label: sourceLabel(connection) }))
      .sort((left, right) => left.label.localeCompare(right.label));
    if (commerce.length === 0) return [];
    return [...commerce, { key: MANUAL_SOURCE, label: MANUAL_SOURCE_LABEL }];
  }, [connectionsQuery.data]);

  const toggleKey = (key: string, checked: boolean) => {
    const keys = checked
      ? [...new Set([...value.keys, key])]
      : value.keys.filter((existing) => existing !== key);
    onChange({ ...value, keys });
  };

  const filterSwitch = (
    <FormControlLabel
      control={
        <Switch
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
      }
      label="Only route selected sources to the queue"
    />
  );

  if (connectionsQuery.loading && !connectionsQuery.data) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Loading sales order sources…
      </Typography>
    );
  }

  if (connectionsQuery.error) {
    return (
      <Stack spacing={0.5}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Sales order sources could not be loaded, so source filtering cannot be changed here.
          Republish the app with the Read Integration permission, then reopen Settings.
        </Typography>
        {value.enabled ? filterSwitch : null}
      </Stack>
    );
  }

  if (options.length === 0) return null;

  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle2">Sales order sources</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {description}
      </Typography>
      {filterSwitch}
      {value.enabled ? (
        <FormGroup sx={{ pl: 1 }}>
          {options.map((option) => (
            <FormControlLabel
              key={option.key}
              control={
                <Checkbox
                  checked={value.keys.includes(option.key)}
                  onChange={(event) => toggleKey(option.key, event.target.checked)}
                />
              }
              label={option.label}
            />
          ))}
        </FormGroup>
      ) : null}
      {sourceFilterInvalid(value) ? (
        <Typography variant="body2" sx={{ color: 'error.main' }}>
          Select at least one source, or turn off the source filter.
        </Typography>
      ) : null}
    </Stack>
  );
}
