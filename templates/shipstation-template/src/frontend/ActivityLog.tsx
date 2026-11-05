import { useMemo, useState } from 'react';

import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import TablePagination from '@mui/material/TablePagination';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';

import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SearchIcon from '@mui/icons-material/Search';

import type { Theme } from '@mui/material/styles';

import { AppErrorAlert, useBackendQuery } from '@heysutton/sdk-react';

import {
  inferActivityOrigin,
  type ActivityOrigin,
} from '../backend/activityOrigin.js';

import SectionHeader from './components/SectionHeader';
import StatusChip from './components/StatusChip';

export type ActivityEvent = {
  id: number;
  createdAt: string;
  actor: string;
  action: string;
  status: string;
  message: string;
  digitOrderId?: string | null;
  ssShipmentId?: string | null;
  channelId?: string | null;
  externalOrderId?: string | null;
  detail?: unknown;
  origin?: ActivityOrigin | null;
};

type ActivityData = { events: ActivityEvent[] };

type TypeFilter = 'all' | 'error' | 'success' | 'warning';

type ActivityLogProps = {
  query: ReturnType<typeof useBackendQuery<ActivityData>>;
};

const monoSx = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '0.7rem',
} as const;

function statusColor(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'success') return 'success';
  if (status === 'skipped' || status === 'warning') return 'warning';
  if (status === 'error' || status === 'failed') return 'error';
  return 'default';
}

function matchesType(status: string, filter: TypeFilter) {
  if (filter === 'all') return true;
  if (filter === 'error') return status === 'error' || status === 'failed';
  if (filter === 'success') return status === 'success';
  return status === 'warning' || status === 'skipped';
}

function accentColor(status: string) {
  const color = statusColor(status);
  if (color === 'default') return 'divider';
  return `${color}.main`;
}

/** Older activity rows were stored with the previous company name. */
function suttonCopy(text: string) {
  return text.replace(/\bDigit\b/g, 'Sutton');
}

function eventDate(createdAt: string) {
  const iso = createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T');
  const normalized = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatWhen(createdAt: string) {
  const date = eventDate(createdAt);
  if (!date) return createdAt;
  return date.toLocaleString();
}

function searchableWhen(createdAt: string) {
  const date = eventDate(createdAt);
  if (!date) return createdAt;
  const pad = (value: number) => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return [
    createdAt,
    date.toISOString(),
    date.toLocaleString(),
    date.toLocaleDateString(),
    date.toLocaleTimeString(),
    `${year}-${month}-${day}`,
    `${month}/${day}/${year}`,
    `${month}/${day}`,
    `${hours}:${minutes}`,
    date.toLocaleString(undefined, { month: 'short' }),
    date.toLocaleString(undefined, { month: 'long' }),
  ].join(' ');
}

function detailRecord(detail: unknown): Record<string, unknown> | null {
  if (detail == null || typeof detail !== 'object' || Array.isArray(detail)) return null;
  return detail as Record<string, unknown>;
}

function stringField(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The stored message, plus a detail message when it is not already included. */
function exactMessages(event: ActivityEvent) {
  const stored = suttonCopy(event.message).trim();
  const fromDetail = stringField(detailRecord(event.detail), 'message');
  const lines = stored ? [stored] : [];
  if (fromDetail) {
    const rewritten = suttonCopy(fromDetail);
    const alreadyShown = lines.some((line) => line.toLowerCase().includes(rewritten.toLowerCase()));
    if (!alreadyShown) lines.push(rewritten);
  }
  if (typeof event.detail === 'string' && event.detail.trim()) {
    const rewritten = suttonCopy(event.detail.trim());
    const alreadyShown = lines.some((line) => line.toLowerCase().includes(rewritten.toLowerCase()));
    if (!alreadyShown) lines.push(rewritten);
  }
  return lines;
}

/** HTTP status, error codes, and request id — the exact upstream facts, not a JSON dump. */
function errorFacts(detail: unknown) {
  const record = detailRecord(detail);
  if (!record) return [];
  const parts: string[] = [];
  if (typeof record.httpStatus === 'number') parts.push(`HTTP ${record.httpStatus}`);
  if (Array.isArray(record.errorCodes)) {
    const codes = record.errorCodes.filter((code): code is string => typeof code === 'string' && code.length > 0);
    if (codes.length > 0) parts.push(codes.join(', '));
  }
  const graphqlCode = stringField(record, 'graphqlCode');
  if (graphqlCode) parts.push(graphqlCode);
  const requestId = stringField(record, 'requestId');
  if (requestId) parts.push(`Request ${requestId}`);
  return parts;
}

function eventOrigin(event: ActivityEvent): ActivityOrigin {
  if (
    event.origin === 'sutton' ||
    event.origin === 'shipstation' ||
    event.origin === 'channel' ||
    event.origin === 'app' ||
    event.origin === 'unknown'
  ) {
    return event.origin;
  }
  return inferActivityOrigin(event);
}

function sourceLabel(origin: ActivityOrigin) {
  if (origin === 'sutton') return 'Sutton';
  if (origin === 'shipstation') return 'ShipStation';
  if (origin === 'channel') return 'Channel';
  if (origin === 'app') return 'In app';
  return null;
}

function inAppChipSx(theme: Theme) {
  const bg = theme.palette.mode === 'dark' ? theme.palette.grey[700] : theme.palette.grey[800];
  const fg = theme.palette.getContrastText(bg);
  return {
    bgcolor: bg,
    color: fg,
    '& .MuiChip-label': { color: fg },
  };
}

function sourceChipColor(origin: ActivityOrigin): 'info' | 'default' {
  return origin === 'sutton' ? 'info' : 'default';
}

function searchHaystack(event: ActivityEvent, origin: ActivityOrigin) {
  return [
    searchableWhen(event.createdAt),
    event.actor,
    event.action,
    event.status,
    ...exactMessages(event),
    ...errorFacts(event.detail),
    event.digitOrderId,
    event.ssShipmentId,
    event.channelId,
    event.externalOrderId,
    sourceLabel(origin),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matchesSearch(haystack: string, query: string) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => haystack.includes(token));
}

function copyText(event: ActivityEvent, origin: ActivityOrigin) {
  const source = sourceLabel(origin);
  const facts = errorFacts(event.detail);
  const lines = [
    `${formatWhen(event.createdAt)} ${event.actor} ${event.action} ${event.status}`,
    source,
    ...exactMessages(event),
    facts.length > 0 ? facts.join(' · ') : null,
    event.digitOrderId ? `Sutton order: ${event.digitOrderId}` : null,
    event.ssShipmentId ? `ShipStation shipment: ${event.ssShipmentId}` : null,
    event.channelId ? `Channel: ${event.channelId}` : null,
    event.externalOrderId ? `External order: ${event.externalOrderId}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export default function ActivityLog({ query }: ActivityLogProps) {
  const events = query.data?.events ?? [];
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  const searched = useMemo(
    () =>
      events.filter((event) =>
        matchesSearch(searchHaystack(event, eventOrigin(event)), search),
      ),
    [events, search],
  );

  const counts = useMemo(
    () => ({
      all: searched.length,
      error: searched.filter((event) => matchesType(event.status, 'error')).length,
      success: searched.filter((event) => matchesType(event.status, 'success')).length,
      warning: searched.filter((event) => matchesType(event.status, 'warning')).length,
    }),
    [searched],
  );

  const filtered = useMemo(
    () => searched.filter((event) => matchesType(event.status, typeFilter)),
    [searched, typeFilter],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * rowsPerPage, safePage * rowsPerPage + rowsPerPage);

  return (
    <Stack spacing={1.5} sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <SectionHeader
        overline="Activity"
        title="Activity log"
        description="Latest 100 events from the past month. Entries older than a month are removed at midnight Pacific. Warnings include skipped shipments. Search matches the date, time, message, and source."
      />
      {query.error ? (
        <AppErrorAlert error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ alignItems: { md: 'center' } }}>
          <TextField
            size="small"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            placeholder="Search date, time, or text"
            aria-label="Search activity by date, time, or text"
            fullWidth
            sx={{ flex: 1 }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          <ToggleButtonGroup
            exclusive
            size="small"
            value={typeFilter}
            aria-label="Filter activity by type"
            onChange={(_, value: TypeFilter | null) => {
              if (!value) return;
              setTypeFilter(value);
              setPage(0);
            }}
            sx={{ flexShrink: 0, flexWrap: 'wrap' }}
          >
            <ToggleButton value="all">All ({counts.all})</ToggleButton>
            <ToggleButton value="error">Errors ({counts.error})</ToggleButton>
            <ToggleButton value="success">Success ({counts.success})</ToggleButton>
            <ToggleButton value="warning">Warnings ({counts.warning})</ToggleButton>
          </ToggleButtonGroup>
      </Stack>
      {events.length === 0 && !query.loading ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          No activity yet. Push an order or connect ShipStation to start the log.
        </Typography>
      ) : null}
      {events.length > 0 && filtered.length === 0 ? (
        <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No events match this search or filter.
          </Typography>
          <Button
            size="small"
            onClick={() => {
              setSearch('');
              setTypeFilter('all');
              setPage(0);
            }}
          >
            Clear search and filter
          </Button>
        </Stack>
      ) : null}
      <Stack spacing={1} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {visible.map((event) => {
          const origin = eventOrigin(event);
          const source = sourceLabel(origin);
          const messages = exactMessages(event);
          const facts = errorFacts(event.detail);
          const isError = event.status === 'error' || event.status === 'failed';
          const refs = [
            event.digitOrderId ? `Order ${event.digitOrderId}` : null,
            event.ssShipmentId ? `ShipStation ${event.ssShipmentId}` : null,
            event.channelId,
            event.externalOrderId ? `External ${event.externalOrderId}` : null,
          ].filter(Boolean);
          return (
            <Stack
              key={event.id}
              direction="row"
              spacing={1}
              sx={{
                alignItems: 'flex-start',
                p: 1.25,
                borderRadius: 1,
                border: 1,
                borderColor: 'divider',
                borderLeftWidth: 4,
                borderLeftColor: accentColor(event.status),
                bgcolor: 'background.default',
              }}
            >
              <Stack spacing={0.75} sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  {source ? (
                    <StatusChip
                      color={sourceChipColor(origin)}
                      label={source}
                      sx={origin === 'app' ? inAppChipSx : undefined}
                    />
                  ) : null}
                  <StatusChip color={statusColor(event.status)} label={event.status} />
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {formatWhen(event.createdAt)} · {event.actor} · {event.action.replace(/_/g, ' ')}
                  </Typography>
                </Stack>
                {messages.map((message) => (
                  <Typography
                    key={message}
                    variant={isError ? 'body1' : 'body2'}
                    sx={{
                      fontWeight: isError ? 600 : 400,
                      color: isError ? 'error.main' : 'text.primary',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {message}
                  </Typography>
                ))}
                {facts.length > 0 ? (
                  <Typography variant="caption" sx={{ color: 'text.secondary', ...monoSx }}>
                    {facts.join(' · ')}
                  </Typography>
                ) : null}
                {refs.length > 0 ? (
                  <Typography variant="caption" sx={{ color: 'text.secondary', ...monoSx }}>
                    {refs.join(' · ')}
                  </Typography>
                ) : null}
              </Stack>
              <Tooltip title="Copy this event">
                <IconButton
                  size="small"
                  aria-label="Copy activity event"
                  onClick={() => void navigator.clipboard.writeText(copyText(event, origin))}
                >
                  <ContentCopyIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            </Stack>
          );
        })}
      </Stack>
      {filtered.length > 0 ? (
        <TablePagination
          component="div"
          count={filtered.length}
          page={safePage}
          onPageChange={(_, nextPage) => setPage(nextPage)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number.parseInt(event.target.value, 10));
            setPage(0);
          }}
          rowsPerPageOptions={[10, 25, 50]}
          sx={{ flexShrink: 0, borderTop: 1, borderColor: 'divider' }}
        />
      ) : null}
    </Stack>
  );
}

export function useActivityQuery(organizationId: string) {
  return useBackendQuery<ActivityData>({
    path: `/sync/activity?organizationId=${encodeURIComponent(organizationId)}`,
    skip: !organizationId,
  });
}
