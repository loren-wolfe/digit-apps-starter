import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';

import RefreshIcon from '@mui/icons-material/Refresh';

import { AppErrorAlert, useBackendMutation, useBackendQuery } from '@heysutton/sdk-react';

import {
  LOCATION_LABEL,
  parseTimestamp,
  type ActivityLogEntry,
  type ActivityLogPage,
  type FulfillmentConfig,
  type SortDir,
} from './types';
import { openRecord } from './host';

const POLL_MS = 4000;
const PAGE_SIZE = 50;

const PHASE_LABEL: Record<string, string> = {
  claimed: 'Claimed',
  deduct: 'Inventory deducted',
  deduct_skipped: 'Deduction skipped',
  order_status: 'Order status updated',
  order_status_skipped: 'Order status skipped',
  complete: 'Complete',
  skipped: 'Skipped',
  shortage: 'Stock shortage',
  error: 'Error',
  reverse_line: 'Inventory reversed (line)',
  reverse_complete: 'Marked errant / un-deducted',
};

function phaseLabel(phase: string) {
  return PHASE_LABEL[phase] || phase.replaceAll('_', ' ');
}

function locationLabel(code: string | null, defaultBinCode: string | null | undefined) {
  if (!code) return 'Unspecified';
  if (code in LOCATION_LABEL) return defaultBinCode || LOCATION_LABEL[code];
  return code;
}

function formatTimestamp(iso: string) {
  const d = parseTimestamp(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function orderLabel(entry: ActivityLogEntry) {
  if (entry.order_number) return `#${entry.order_number}`;
  if (entry.wc_order_id) return `#${entry.wc_order_id}`;
  return '—';
}

function SuttonSoLink({ entry }: { entry: ActivityLogEntry }) {
  const label = entry.digit_order_number || (entry.digit_so_id ? entry.digit_so_id.slice(0, 8) : null);
  if (!label) return <>—</>;
  if (!entry.digit_so_id) return <>{label}</>;
  return (
    <Link
      component="button"
      type="button"
      variant="body2"
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        openRecord('salesOrder', entry.digit_so_id as string);
      }}
    >
      {label}
    </Link>
  );
}

function detailText(entry: ActivityLogEntry) {
  const parts: string[] = [];
  if (entry.message) parts.push(entry.message);
  if (entry.item_id && entry.quantity != null) parts.push(`qty ${entry.quantity}`);
  if (entry.document_number) parts.push(`doc ${entry.document_number}`);
  if (entry.error_code) parts.push(`[${entry.error_code}]`);
  return parts.join(' · ') || '—';
}

export default function ActivityLog() {
  const [dir, setDir] = useState<SortDir>('desc');
  const [nodes, setNodes] = useState<ActivityLogEntry[]>([]);
  const [extra, setExtra] = useState<ActivityLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const extraRef = useRef(extra);
  const dirRef = useRef(dir);
  extraRef.current = extra;
  dirRef.current = dir;

  const path = `/fulfillment/log?limit=${PAGE_SIZE}&dir=${dir}`;
  const logQuery = useBackendQuery<ActivityLogPage>({ path });
  const configQuery = useBackendQuery<FulfillmentConfig>({ path: '/fulfillment/config' });
  const [mutate] = useBackendMutation<ActivityLogPage>();

  useEffect(() => {
    if (!logQuery.data) return;
    setNodes(logQuery.data.nodes);
  }, [logQuery.data]);

  // Switching sort direction starts over — a cached "page 2" from the opposite order
  // wouldn't line up with the newly-sorted first page.
  useEffect(() => {
    setExtra([]);
    setHasMore(false);
  }, [dir]);

  useEffect(() => {
    if (!logQuery.data) return;
    setHasMore(logQuery.data.pageInfo.hasMore);
  }, [logQuery.data]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void logQuery.refetch();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [logQuery.refetch]);

  const rows = [...nodes, ...extra];

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const nextPath = `/fulfillment/log?limit=${PAGE_SIZE}&dir=${dirRef.current}&offset=${nodes.length + extraRef.current.length}`;
    // GET through useBackendMutation's `mutate` (not a bare `fetch`) so the call carries the
    // same session/signing the platform proxy requires — a plain fetch to this path gets
    // rejected with INVALID_ORIGIN.
    const result = await mutate({ path: nextPath, method: 'GET' });
    setLoadingMore(false);
    if (!result.ok) return;
    setExtra((prev) => [...prev, ...result.data.nodes]);
    setHasMore(result.data.pageInfo.hasMore);
  }, [mutate, nodes.length]);

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'flex-end' } }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.16em' }}>
            WooCommerce → Sutton
          </Typography>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 650, letterSpacing: '-0.02em' }}>
            Activity log
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, maxWidth: 640 }}>
            Every inventory and order-status event across every order, in time order.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={dir}
            onChange={(_event, next) => {
              if (next) setDir(next);
            }}
          >
            <ToggleButton value="desc">Newest first</ToggleButton>
            <ToggleButton value="asc">Oldest first</ToggleButton>
          </ToggleButtonGroup>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshIcon fontSize="small" />}
            onClick={() => void logQuery.refetch()}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      {logQuery.error ? <AppErrorAlert error={logQuery.error} onRetry={() => void logQuery.refetch()} /> : null}

      {logQuery.data === undefined && !logQuery.error ? (
        <Typography sx={{ color: 'text.secondary' }}>Loading log…</Typography>
      ) : null}
      {logQuery.data !== undefined && rows.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>
          No activity yet. Events appear here as orders are matched, approved, and applied.
        </Typography>
      ) : null}

      {rows.length > 0 ? (
        <Box sx={{ borderTop: 1, borderColor: 'divider', overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 880 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600, whiteSpace: 'nowrap' }}>Time</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Woo order</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Sutton order</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Bin</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Phase</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Trigger</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Result</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontWeight: 600 }}>Detail</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((entry) => (
                <TableRow key={entry.id} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary', fontFamily: 'ui-monospace, monospace' }}>
                    {formatTimestamp(entry.created_at)}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'ui-monospace, monospace' }}>{orderLabel(entry)}</TableCell>
                  <TableCell>
                    <SuttonSoLink entry={entry} />
                  </TableCell>
                  <TableCell>{locationLabel(entry.warehouse_location, configQuery.data?.warehouseLocationCode)}</TableCell>
                  <TableCell>{phaseLabel(entry.phase)}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{entry.trigger}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="filled"
                      color={entry.ok ? 'success' : 'error'}
                      label={entry.ok ? 'OK' : 'Failed'}
                      sx={{ fontWeight: 600 }}
                    />
                  </TableCell>
                  <TableCell sx={{ color: entry.ok ? 'text.secondary' : 'error.main', overflowWrap: 'anywhere' }}>
                    {detailText(entry)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {hasMore ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <Button size="small" variant="outlined" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Stack>
  );
}
