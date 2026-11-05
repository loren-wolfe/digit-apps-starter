import { useCallback, useEffect, useRef, useState, type ChangeEvent, type MouseEvent, type ReactNode } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import LinearProgress from '@mui/material/LinearProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TablePagination from '@mui/material/TablePagination';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ClearIcon from '@mui/icons-material/Clear';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';

import {
  AppErrorAlert,
  useBackendMutation,
  useBackendQuery,
  type AppError,
  type ApiResult,
} from '@heysutton/sdk-react';

import {
  ERROR_STATUSES,
  ERROR_TITLES,
  LOCATION_LABEL,
  LOCATION_OPTIONS,
  STATUS_OPTIONS,
  parseTimestamp,
  type ApplyEvent,
  type FulfillmentConfig,
  type FulfillmentSync,
  type GroupField,
  type InventoryLine,
  type SortDir,
  type SortField,
  type SyncFacets,
  type SyncsPage,
  type ReconcileStatus,
} from './types';
import { isDigitId, openItem, openRecord } from './host';

const POLL_MS = 4000;
const POLL_STATUS_MS = 30000;
const POLL_JOB_NAME = 'woocommerce-poll';
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

// Bulk actions fire one backend call per selected row in sequence — never concurrently — and
// wait for each to fully resolve before the next. Even so, two distinct transient-failure
// modes show up under a large batch:
//   - RATE_LIMITED (`kind=platform`): the Sutton platform rate-limits calls across the
//     frontend-to-backend proxy channel, which a page-sized batch fired back-to-back can trip.
//   - BACKEND_UNAVAILABLE (`kind=platform`, HTTP 502): the platform proxy didn't get a response
//     from the app Worker in time. "Retry" previews now do more sequential Sutton GraphQL round
//     trips per row than before (match, then address/items/location), so a single slow row can
//     trip this even without any concurrency on the frontend's part.
// Both are transient and worth a short backoff-retry instead of immediately marking that row
// failed — a page-sized batch should not need the operator to notice and re-click rows one by
// one just because one row's preview was briefly slow upstream.
const BULK_ACTION_DELAY_MS = 150;
const BULK_RETRY_DELAYS_MS = [500, 1500, 3000];
const TRANSIENT_ERROR_CODES = new Set(['RATE_LIMITED', 'BACKEND_UNAVAILABLE']);

function isTransientError(error: AppError) {
  if (TRANSIENT_ERROR_CODES.has(error.code || '')) return true;
  // Generic upstream/server 5xx from the backend itself (not a platform-level rejection like a
  // config error) is also worth one retry rather than failing the whole row outright.
  return typeof error.status === 'number' && error.status >= 500 && error.code !== 'MISSING_CONFIG';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `mutate(args)`, retrying with backoff only on transient (rate-limit / 502) failures. */
async function mutateWithRateLimitRetry<T>(
  mutate: (args: { path: string; method: string; body?: Record<string, unknown> }) => Promise<ApiResult<T>>,
  args: { path: string; method: string; body?: Record<string, unknown> },
) {
  let result = await mutate(args);
  for (const delay of BULK_RETRY_DELAYS_MS) {
    if (result.ok || !isTransientError(result.error)) break;
    await sleep(delay);
    result = await mutate(args);
  }
  return result;
}

const COL = {
  select: 32,
  status: 150,
  order: 92,
  sutton: 120,
  location: 108,
  received: 92,
  updated: 150,
  detail: 200,
} as const;

const HEADER_LABEL_SX = { color: 'text.secondary', fontWeight: 600 };

function SortableHeaderCell({
  label,
  width,
  field,
  sortField,
  sortDir,
  onSort,
}: {
  label: string;
  width: number;
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const active = sortField === field;
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={() => onSort(field)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSort(field);
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        width,
        flexShrink: 0,
        cursor: 'pointer',
        userSelect: 'none',
        color: active ? 'text.primary' : 'text.secondary',
        '&:hover .fq-sort-icon': { opacity: 1 },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <Typography variant="caption" component="span" sx={{ ...HEADER_LABEL_SX, color: 'inherit' }}>
        {label}
      </Typography>
      {active ? (
        sortDir === 'desc' ? (
          <ArrowDownwardIcon fontSize="inherit" sx={{ fontSize: 14 }} />
        ) : (
          <ArrowUpwardIcon fontSize="inherit" sx={{ fontSize: 14 }} />
        )
      ) : (
        <UnfoldMoreIcon
          fontSize="inherit"
          className="fq-sort-icon"
          sx={{ fontSize: 14, opacity: 0.45, transition: 'opacity 120ms ease' }}
        />
      )}
    </Box>
  );
}

function QueueHeader({
  sortField,
  sortDir,
  onSort,
  allSelected,
  someSelected,
  onToggleAll,
}: {
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.75,
        bgcolor: 'background.paper',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Box sx={{ width: COL.select, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <Checkbox
          size="small"
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleAll}
          onClick={(event) => event.stopPropagation()}
          slotProps={{ input: { 'aria-label': 'Select all rows' } }}
          sx={{ p: 0.25 }}
        />
      </Box>
      <SortableHeaderCell
        label="Status"
        width={COL.status}
        field="status"
        sortField={sortField}
        sortDir={sortDir}
        onSort={onSort}
      />
      <Typography variant="caption" component="div" sx={{ ...HEADER_LABEL_SX, width: COL.order, flexShrink: 0 }}>
        Woo order
      </Typography>
      <SortableHeaderCell
        label="Sutton order"
        width={COL.sutton}
        field="so"
        sortField={sortField}
        sortDir={sortDir}
        onSort={onSort}
      />
      <SortableHeaderCell
        label="Location"
        width={COL.location}
        field="location"
        sortField={sortField}
        sortDir={sortDir}
        onSort={onSort}
      />
      <SortableHeaderCell
        label="Received"
        width={COL.received}
        field="received"
        sortField={sortField}
        sortDir={sortDir}
        onSort={onSort}
      />
      <SortableHeaderCell
        label="Updated"
        width={COL.updated}
        field="updated"
        sortField={sortField}
        sortDir={sortDir}
        onSort={onSort}
      />
      <Typography variant="caption" component="div" sx={{ ...HEADER_LABEL_SX, flex: 1, minWidth: COL.detail }}>
        Detail
      </Typography>
    </Box>
  );
}

function isDeductEligible(sync: FulfillmentSync) {
  const stockBlocked = sync.error_code === 'STOCK_SHORTAGE' && !sync.error_detail?.stockReady;
  return sync.status === 'pending_approval' && Boolean(sync.wc_completed_at) && !stockBlocked;
}

// `skipped` is included here (and in canRetryPreview below) so Retry works on a skipped row in
// one click — the backend transparently clears the skip and re-previews in the same call,
// instead of requiring Unskip first, re-selecting the row, then clicking Retry separately.
const REMATCH_STATUSES = new Set(['unmatched', 'missing_address', 'failed', 'rejected', 'skipped']);

function isDeleteEligible(sync: FulfillmentSync) {
  return sync.status === 'skipped';
}

function isRematchEligible(sync: FulfillmentSync) {
  return REMATCH_STATUSES.has(sync.status);
}


function statusChipColor(status: string): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'fulfilled') return 'success';
  if (status === 'pending_approval' || status === 'ready' || status === 'applying') return 'warning';
  if (status === 'reversed') return 'warning';
  if (ERROR_STATUSES.has(status)) return 'error';
  return 'default';
}

/** A row that has not deducted stores PRIMARY, meaning the current default bin. A row that
 * deducted stores the bin code(s) its stock came from. */
function locationLabel(code: string | null, defaultBinCode: string | null | undefined) {
  if (!code) return 'Unspecified';
  if (code in LOCATION_LABEL) return defaultBinCode || LOCATION_LABEL[code];
  return code;
}

function formatTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = parseTimestamp(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Drop seconds (the default toLocaleString() includes them) so this fits on one line
  // inside the "Updated" column instead of wrapping onto a second line for "AM"/"PM".
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatEpoch(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** One-line summary of the WooCommerce poll: the last finished run, or one in progress, and the next tick. */
function pollStatusText(status: ReconcileStatus | null | undefined) {
  if (!status) return null;
  const runs = status.recentRuns.filter((run) => run.name === POLL_JOB_NAME);
  const schedule = status.schedule;
  const inProgress = schedule?.running || runs.some((run) => run.status === 'running' || run.status === 'queued');
  const last = runs.find((run) => run.endedAt != null);

  let text = inProgress ? 'WooCommerce poll running now.' : 'No WooCommerce poll has run yet.';
  if (last?.endedAt != null && !inProgress) {
    const how = last.kind === 'schedule' ? 'scheduled' : 'Run now';
    const outcome = last.status === 'succeeded' ? '' : `, ${last.status}`;
    text = `Last WooCommerce poll: ${formatEpoch(last.endedAt)} (${how}${outcome}).`;
  }
  if (schedule?.autoPaused) text += ' Scheduled polling is paused after repeated failures.';
  else if (schedule?.nextDueAt) text += ` Next: ${formatEpoch(schedule.nextDueAt)}.`;
  if (!inProgress) text += ' To poll now, open the Configuration tab and click Run now.';
  return text;
}

function formatDate(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return '—';
  const d = parseTimestamp(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone });
}

function orderLabel(s: FulfillmentSync) {
  return s.order_number ? `#${s.order_number}` : s.wc_order_id ? `#${s.wc_order_id}` : '—';
}

function errorHeadline(sync: FulfillmentSync) {
  if (sync.error_code === 'STOCK_SHORTAGE' && sync.error_detail?.stockReady) return 'Stock available';
  if (sync.error_code && ERROR_TITLES[sync.error_code]) return ERROR_TITLES[sync.error_code];
  if (sync.error) {
    const dash = sync.error.indexOf(' — ');
    if (dash > 0) return sync.error.slice(0, dash);
  }
  return sync.error;
}

/** Stable identity for a line, with a fallback for rows from before kit support (no lineKey). */
function effectiveLineKey(line: InventoryLine): string | undefined {
  return line.lineKey || line.itemId;
}

/** The compensating reversal line for `line`, if "Mark errant / Un-deduct" has already given
 * its inventory back — looked up by lineKey the same way `appliedMap` does on the backend. */
function reversedLineFor(line: InventoryLine, sync: FulfillmentSync): InventoryLine | null {
  const key = effectiveLineKey(line);
  if (!key) return null;
  return (sync.reversed_items || []).find((reversed) => effectiveLineKey(reversed) === key) || null;
}

function lineErrorMessage(line: InventoryLine, sync: FulfillmentSync) {
  const key = effectiveLineKey(line);
  for (const s of sync.error_detail?.shortages || []) {
    const sKey = s.lineKey || s.itemId;
    if ((key && sKey === key) || (line.itemName && s.itemName === line.itemName)) {
      return `need ${s.need}, have ${s.have}`;
    }
  }
  return null;
}

function inventoryLines(sync: FulfillmentSync): InventoryLine[] {
  const applied = new Map<string, InventoryLine>();
  for (const line of sync.applied_items || []) {
    const key = effectiveLineKey(line);
    if (key) applied.set(key, line);
  }
  for (const line of sync.items_preview || []) {
    const key = effectiveLineKey(line);
    if (key && (line.adjustmentId || line.documentNumber) && !applied.has(key)) {
      applied.set(key, line);
    }
  }
  const seen = new Set<string>();
  const lines: InventoryLine[] = [];
  for (const line of sync.items_preview || []) {
    const key = effectiveLineKey(line);
    if (key) seen.add(key);
    lines.push({ ...line, ...((key && applied.get(key)) || {}) });
  }
  for (const [key, line] of applied) {
    if (!seen.has(key)) lines.push(line);
  }
  return lines;
}

function SuttonSoLink({ sync }: { sync: FulfillmentSync }) {
  const label = sync.digit_order_number || (sync.digit_so_id ? sync.digit_so_id.slice(0, 8) : null);
  if (!label) return <>—</>;
  if (!sync.digit_so_id) return <>{label}</>;
  return (
    <Link
      component="button"
      type="button"
      variant="body2"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        openRecord('salesOrder', sync.digit_so_id as string);
      }}
    >
      {label}
    </Link>
  );
}

/** Links a line's item to the host's item modal — only when `itemId` is a real Digit id (an
 * unresolved alias line falls back to a raw, non-Digit identifier that can't be opened). */
function ItemLink({ id, label }: { id: string | null | undefined; label: string }) {
  if (!isDigitId(id)) return <>{label}</>;
  return (
    <Link
      component="button"
      type="button"
      variant="body2"
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        openItem(id);
      }}
    >
      {label}
    </Link>
  );
}

// The Kit column stays visible for rows that were expanded from a kit, so turning virtual kits
// off later doesn't hide which kit an existing deduction came from.
function InventoryBlock({ sync, virtualKitsEnabled }: { sync: FulfillmentSync; virtualKitsEnabled: boolean }) {
  const lines = inventoryLines(sync);
  if (!lines.length && !sync.error) return null;
  const showKit = virtualKitsEnabled || lines.some((line) => line.kitItemId);
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="overline" sx={{ color: 'text.secondary' }}>
        Inventory
      </Typography>
      {sync.error ? (
        <Typography variant="body2" sx={{ color: 'error.main', mb: 1 }}>
          {sync.error}
        </Typography>
      ) : null}
      {lines.length > 0 ? (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Item</TableCell>
              <TableCell>Qty</TableCell>
              {showKit ? <TableCell>Kit</TableCell> : null}
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {lines.map((line, index) => {
              const shortage = lineErrorMessage(line, sync);
              const reversed = reversedLineFor(line, sync);
              let status = 'Pending';
              if (shortage) status = shortage;
              else if (reversed) status = reversed.documentNumber ? `Reversed · ${reversed.documentNumber}` : 'Reversed';
              else if (line.documentNumber || line.adjustmentId) {
                status = line.documentNumber ? `Deducted · ${line.documentNumber}` : 'Deducted';
              } else if (sync.status === 'fulfilled') status = 'Deducted';
              else if (sync.status === 'rejected' || sync.status === 'skipped') status = 'Not deducted';
              return (
                <TableRow key={effectiveLineKey(line) || index}>
                  <TableCell>
                    <ItemLink id={line.itemId} label={line.itemName} />
                  </TableCell>
                  <TableCell>{line.quantity}</TableCell>
                  {showKit ? (
                    <TableCell sx={{ color: 'text.secondary' }}>
                      {line.kitItemId ? (
                        <>
                          <ItemLink id={line.kitItemId} label={line.kitSku || line.kitItemName || ''} />
                          {` × ${line.kitLineQuantity}`}
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell sx={{ color: shortage ? 'error.main' : 'text.secondary' }}>{status}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </Box>
  );
}

function ActivityBlock({ events }: { events: ApplyEvent[] | undefined }) {
  if (!events?.length) return null;
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="overline" sx={{ color: 'text.secondary' }}>
        Activity ({events.length})
      </Typography>
      <Stack spacing={0.5} sx={{ mt: 0.5 }}>
        {events.map((ev) => (
          <Typography key={ev.id} variant="caption" sx={{ fontFamily: 'ui-monospace, monospace' }}>
            {formatTime(ev.created_at)} · {ev.phase}
            {ev.message ? ` — ${ev.message}` : ''}
            {ev.error_code ? ` [${ev.error_code}]` : ''}
          </Typography>
        ))}
      </Stack>
    </Box>
  );
}

/** Spinner shown inside whichever button triggered the in-flight call, so a click gives
 * immediate feedback instead of a silently-disabled button with no visual change. */
function actionIcon(active: boolean) {
  return active ? <CircularProgress size={14} color="inherit" /> : undefined;
}

function SyncActions({
  sync: s,
  autoApply,
  busy,
  activeAction,
  onAction,
  onRequestReverse,
}: {
  sync: FulfillmentSync;
  autoApply: boolean;
  busy: boolean;
  /** Which action is currently in flight for this row (only meaningful while `busy`). */
  activeAction: string | null;
  onAction: (path: string, body?: Record<string, unknown>) => void;
  /** Opens the note-required "Mark errant / Un-deduct" dialog for this row — a reversal
   * always needs operator-entered context, unlike the other actions here, so it can't just
   * fire `onAction` directly with a fixed body. */
  onRequestReverse: () => void;
}) {
  const appliedCount = (s.applied_items || []).length;
  const stockBlocked = s.error_code === 'STOCK_SHORTAGE' && !s.error_detail?.stockReady;
  const canApprove = isDeductEligible(s);
  const awaiting = s.status === 'awaiting_completion';
  const canResume =
    !stockBlocked && s.status === 'needs_attention' && s.error_code !== 'ORDER_STATUS_FAILED' && appliedCount > 0;
  const canRetryApply =
    !stockBlocked &&
    // Retry apply only makes sense once the row actually matched a Sutton order — a
    // preview-level failure (SUTTON_API, UNMATCHED, INCOMPLETE_ITEMS, etc., all land as
    // `failed` with no digit_so_id) has nothing to apply yet. "Retry" (canRetryPreview) is the
    // correct retry for those instead.
    Boolean(s.digit_so_id) &&
    (Boolean(s.wc_completed_at) || appliedCount > 0) &&
    (s.status === 'failed' ||
      (s.status === 'needs_attention' && s.error_code !== 'ORDER_STATUS_FAILED' && appliedCount === 0));
  const canRetryStatus = s.status === 'needs_attention' && s.error_code === 'ORDER_STATUS_FAILED';
  const canRetryPreview = ['unmatched', 'missing_address', 'failed', 'rejected', 'skipped'].includes(
    s.status,
  );
  const canResolve = ['needs_attention', 'failed', 'unmatched', 'missing_address'].includes(s.status);
  const canRemove =
    s.status === 'unmatched' && !s.order_status_applied && (s.applied_items || []).length === 0;
  const canRestore = s.status === 'removed';
  const canDelete = s.status === 'skipped';
  // Only once inventory has actually been deducted — a needs_attention row from a stock
  // shortage or a preview-level failure has nothing yet to give back.
  const canReverse = ['fulfilled', 'needs_attention'].includes(s.status) && appliedCount > 0;
  const canRerun = s.status === 'reversed';

  return (
    <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', mt: 2 }}>
      {awaiting ? (
        <>
          <Typography variant="body2" sx={{ color: 'text.secondary', width: '100%' }}>
            Waiting for WooCommerce to mark this order Completed. The next poll after that moves it to
            Pending approval, or deducts it when auto-apply is on.
          </Typography>
          <Button
            size="small"
            color="error"
            disabled={busy}
            startIcon={actionIcon(busy && activeAction === 'reject')}
            onClick={() => onAction('reject')}
          >
            {busy && activeAction === 'reject' ? 'Rejecting…' : 'Reject'}
          </Button>
        </>
      ) : null}
      {canApprove ? (
        <>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            startIcon={actionIcon(busy && activeAction === 'approve')}
            onClick={() => onAction('approve')}
          >
            {busy && activeAction === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button
            size="small"
            color="error"
            disabled={busy}
            startIcon={actionIcon(busy && activeAction === 'reject')}
            onClick={() => onAction('reject')}
          >
            {busy && activeAction === 'reject' ? 'Rejecting…' : 'Reject'}
          </Button>
        </>
      ) : null}
      {stockBlocked ? (
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'recheck-stock')}
          onClick={() => onAction('recheck-stock')}
        >
          {busy && activeAction === 'recheck-stock' ? 'Checking…' : 'Recheck stock'}
        </Button>
      ) : null}
      {canResume ? (
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'resume')}
          onClick={() => onAction('resume')}
        >
          {busy && activeAction === 'resume' ? 'Resuming…' : 'Resume apply'}
        </Button>
      ) : null}
      {canRetryApply ? (
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'apply')}
          onClick={() => onAction('apply')}
        >
          {busy && activeAction === 'apply' ? 'Retrying…' : 'Retry apply'}
        </Button>
      ) : null}
      {canRetryStatus ? (
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'retry-order-status')}
          onClick={() => onAction('retry-order-status')}
        >
          {busy && activeAction === 'retry-order-status' ? 'Retrying…' : 'Retry order status'}
        </Button>
      ) : null}
      {canRetryPreview ? (
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'retry')}
          onClick={() => onAction('retry')}
        >
          {busy && activeAction === 'retry' ? 'Retrying…' : 'Retry'}
        </Button>
      ) : null}
      {canResolve ? (
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'resolve')}
          onClick={() => onAction('resolve', { note: 'Resolved manually after Sutton-side fix' })}
        >
          {busy && activeAction === 'resolve' ? 'Resolving…' : 'Mark resolved'}
        </Button>
      ) : null}
      {canRemove ? (
        <Stack spacing={0.5} sx={{ width: '100%' }}>
          <Box>
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={busy}
              startIcon={actionIcon(busy && activeAction === 'remove')}
              onClick={() => onAction('remove')}
            >
              {busy && activeAction === 'remove' ? 'Removing…' : 'Remove from log'}
            </Button>
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            This order leaves the log and will not be queued again unless it is restored.
          </Typography>
        </Stack>
      ) : null}
      {canRestore ? (
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'restore')}
          onClick={() => onAction('restore')}
        >
          {busy && activeAction === 'restore' ? 'Restoring…' : 'Restore'}
        </Button>
      ) : null}
      {canReverse ? (
        <Button
          size="small"
          color="error"
          variant="outlined"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'reverse')}
          onClick={onRequestReverse}
        >
          {busy && activeAction === 'reverse' ? 'Undoing deduction…' : 'Undo deduction'}
        </Button>
      ) : null}
      {canRerun ? (
        <Stack spacing={0.5} sx={{ width: '100%' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Inventory for this order was put back. Rerun deducts it again. The Sutton order stays fulfilled.
          </Typography>
          <Box>
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              startIcon={actionIcon(busy && activeAction === 'rerun')}
              onClick={() => onAction('rerun')}
            >
              {busy && activeAction === 'rerun' ? 'Rerunning…' : 'Rerun'}
            </Button>
          </Box>
        </Stack>
      ) : null}
      {canDelete ? (
        <Button
          size="small"
          color="error"
          variant="outlined"
          disabled={busy}
          startIcon={actionIcon(busy && activeAction === 'delete')}
          onClick={() => onAction('delete')}
        >
          {busy && activeAction === 'delete' ? 'Deleting…' : 'Delete'}
        </Button>
      ) : null}
    </Stack>
  );
}

function SyncRow({
  sync,
  expanded,
  busy,
  activeAction,
  autoApply,
  virtualKitsEnabled,
  defaultBinCode,
  events,
  rowError,
  selected,
  selectDisabled,
  onToggle,
  onToggleSelect,
  onAction,
  onRequestReverse,
}: {
  sync: FulfillmentSync;
  expanded: boolean;
  busy: boolean;
  activeAction: string | null;
  autoApply: boolean;
  virtualKitsEnabled: boolean;
  defaultBinCode: string | null;
  events: ApplyEvent[] | undefined;
  /** Error from the last action *attempted on this row*, kept separate from `sync.error`
   * (the server-persisted state) so a request that fails before anything is written —
   * e.g. a 500 from the backend — still shows up right here instead of vanishing. */
  rowError: AppError | undefined;
  selected: boolean;
  selectDisabled: boolean;
  onToggle: () => void;
  onToggleSelect: () => void;
  onAction: (path: string, body?: Record<string, unknown>) => void;
  onRequestReverse: () => void;
}) {
  const headline = rowError ? 'Last action failed — expand for details' : errorHeadline(sync);
  return (
    <Box>
      <Box
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          py: 0.75,
          px: 1,
          cursor: 'pointer',
          bgcolor: selected ? 'action.selected' : undefined,
          '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        }}
      >
        <Box sx={{ width: COL.select, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          <Checkbox
            size="small"
            checked={selected}
            disabled={selectDisabled}
            onChange={onToggleSelect}
            onClick={(event) => event.stopPropagation()}
            slotProps={{ input: { 'aria-label': `Select order ${orderLabel(sync)}` } }}
            sx={{ p: 0.25 }}
          />
        </Box>
        <Box sx={{ width: COL.status, flexShrink: 0 }}>
          <Chip
            size="small"
            label={sync.status.replaceAll('_', ' ')}
            color={statusChipColor(sync.status)}
            variant="filled"
            sx={{ maxWidth: '100%', fontWeight: 600, textTransform: 'capitalize' }}
          />
        </Box>
        <Typography variant="body2" sx={{ width: COL.order, flexShrink: 0, fontFamily: 'ui-monospace, monospace' }}>
          {orderLabel(sync)}
        </Typography>
        <Box sx={{ width: COL.sutton, flexShrink: 0 }}>
          <SuttonSoLink sync={sync} />
        </Box>
        <Typography variant="body2" sx={{ width: COL.location, flexShrink: 0 }}>
          {sync.warehouse_location ? locationLabel(sync.warehouse_location, defaultBinCode) : '—'}
        </Typography>
        <Typography variant="caption" sx={{ width: COL.received, flexShrink: 0, color: 'text.secondary' }}>
          {formatDate(sync.order_received_date)}
        </Typography>
        <Typography
          variant="caption"
          sx={{ width: COL.updated, flexShrink: 0, color: 'text.secondary', whiteSpace: 'nowrap' }}
        >
          {formatTime(sync.updated_at)}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            flex: 1,
            minWidth: COL.detail,
            color: rowError || ERROR_STATUSES.has(sync.status) ? 'error.main' : 'text.secondary',
            overflowWrap: 'anywhere',
          }}
        >
          {headline || ''}
        </Typography>
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ pl: 3, pr: 1, pb: 2 }}>
          {rowError ? (
            <Box sx={{ mb: 1.5 }}>
              <AppErrorAlert error={rowError} title="This action failed" />
            </Box>
          ) : null}
          <InventoryBlock sync={sync} virtualKitsEnabled={virtualKitsEnabled} />
          <SyncActions
            sync={sync}
            autoApply={autoApply}
            busy={busy}
            activeAction={activeAction}
            onAction={onAction}
            onRequestReverse={onRequestReverse}
          />
          <ActivityBlock events={events} />
        </Box>
      </Collapse>
    </Box>
  );
}

const GROUP_OPTIONS: { value: GroupField; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'status', label: 'Status' },
  { value: 'location', label: 'Location' },
];

function multiSelectRenderValue(selected: string[], options: { value: string; label: string }[]) {
  if (!selected.length) return '';
  const map = new Map(options.map((o) => [o.value, o.label]));
  return selected.map((v) => map.get(v) || v).join(', ');
}

function FiltersBar({
  statusOptions,
  statusFilter,
  onStatusFilterChange,
  locationOptions,
  locationFilter,
  onLocationFilterChange,
  search,
  onSearchChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  groupBy,
  onGroupByChange,
  onClear,
  hasActiveFilters,
}: {
  statusOptions: { value: string; label: string; count?: number }[];
  statusFilter: string[];
  onStatusFilterChange: (next: string[]) => void;
  locationOptions: { value: string; label: string; count?: number }[];
  locationFilter: string[];
  onLocationFilterChange: (next: string[]) => void;
  search: string;
  onSearchChange: (next: string) => void;
  dateFrom: string;
  onDateFromChange: (next: string) => void;
  dateTo: string;
  onDateToChange: (next: string) => void;
  groupBy: GroupField;
  onGroupByChange: (next: GroupField) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}) {
  const handleStatus = (event: SelectChangeEvent<string[]>) => {
    const value = event.target.value;
    onStatusFilterChange(typeof value === 'string' ? value.split(',') : value);
  };
  const handleLocation = (event: SelectChangeEvent<string[]>) => {
    const value = event.target.value;
    onLocationFilterChange(typeof value === 'string' ? value.split(',') : value);
  };
  const rowLabelSx = {
    color: 'text.secondary',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    minWidth: 44,
    flexShrink: 0,
  };

  return (
    <Stack spacing={1.25} sx={{ pb: 0.5 }}>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="caption" component="span" sx={rowLabelSx}>
          View
        </Typography>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel id="fq-group-label">Group by</InputLabel>
          <Select
            labelId="fq-group-label"
            label="Group by"
            value={groupBy}
            onChange={(event) => onGroupByChange(event.target.value as GroupField)}
          >
            {GROUP_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="caption" component="span" sx={rowLabelSx}>
          Filter
        </Typography>
      <TextField
        size="small"
        type="search"
        label="Order number"
        placeholder="e.g. 128 or SO38"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        slotProps={{
          input: { startAdornment: <SearchIcon fontSize="small" sx={{ color: 'text.secondary', mr: 0.75 }} /> },
          inputLabel: { shrink: true },
        }}
        sx={{ minWidth: 240 }}
      />
      <FormControl size="small" sx={{ minWidth: 160 }} disabled={statusOptions.length === 0}>
        <InputLabel id="fq-status-label">Status</InputLabel>
        <Select
          labelId="fq-status-label"
          label="Status"
          multiple
          value={statusFilter}
          onChange={handleStatus}
          renderValue={(selected) => multiSelectRenderValue(selected, statusOptions) || 'All statuses'}
        >
          {statusOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              <Checkbox size="small" checked={statusFilter.includes(opt.value)} sx={{ p: 0.5, mr: 1 }} />
              {opt.label}
              {opt.count != null ? (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
                  ({opt.count})
                </Typography>
              ) : null}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl size="small" sx={{ minWidth: 160 }} disabled={locationOptions.length === 0}>
        <InputLabel id="fq-location-label">Location</InputLabel>
        <Select
          labelId="fq-location-label"
          label="Location"
          multiple
          value={locationFilter}
          onChange={handleLocation}
          renderValue={(selected) => multiSelectRenderValue(selected, locationOptions) || 'All locations'}
        >
          {locationOptions.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              <Checkbox size="small" checked={locationFilter.includes(opt.value)} sx={{ p: 0.5, mr: 1 }} />
              {opt.label}
              {opt.count != null ? (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
                  ({opt.count})
                </Typography>
              ) : null}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <TextField
        size="small"
        type="date"
        label="Received from"
        value={dateFrom}
        onChange={(event) => onDateFromChange(event.target.value)}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 160 }}
      />
      <TextField
        size="small"
        type="date"
        label="Received to"
        value={dateTo}
        onChange={(event) => onDateToChange(event.target.value)}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 160 }}
      />

      {hasActiveFilters ? (
        <Button size="small" startIcon={<ClearIcon fontSize="small" />} onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
      </Stack>
    </Stack>
  );
}

function BulkActionBar({
  selectedCount,
  eligibleDeductCount,
  eligibleRematchCount,
  eligibleDeleteCount,
  busy,
  activeAction,
  onDeduct,
  onRematch,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  eligibleDeductCount: number;
  eligibleRematchCount: number;
  eligibleDeleteCount: number;
  busy: boolean;
  activeAction: 'deduct' | 'rematch' | 'delete' | null;
  onDeduct: () => void;
  onRematch: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const hints: string[] = [];
  if (eligibleDeductCount > 0) hints.push(`${eligibleDeductCount} eligible for inventory deduction`);
  // `skipped` rows are included here too — Retry on them runs the Unskip+preview in one call.
  if (eligibleRematchCount > 0) hints.push(`${eligibleRematchCount} eligible to retry`);
  if (eligibleDeleteCount > 0) hints.push(`${eligibleDeleteCount} eligible to delete`);

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        flexWrap: 'wrap',
        px: 1.5,
        py: 1,
        border: 1,
        borderColor: 'primary.main',
        borderRadius: 1,
        bgcolor: 'action.hover',
        overflow: 'hidden',
      }}
    >
      {busy ? (
        <LinearProgress
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2 }}
        />
      ) : null}
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {selectedCount} selected
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {hints.length ? hints.join(' · ') : 'None of the selected orders support a bulk action right now'}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Button size="small" onClick={onClear} disabled={busy}>
        Clear selection
      </Button>
      <Button
        size="small"
        variant="outlined"
        disabled={busy || eligibleRematchCount === 0}
        startIcon={activeAction === 'rematch' ? <CircularProgress size={14} color="inherit" /> : undefined}
        onClick={onRematch}
      >
        {activeAction === 'rematch' ? 'Retrying…' : `Retry (${eligibleRematchCount})`}
      </Button>
      <Button
        size="small"
        color="error"
        variant="outlined"
        disabled={busy || eligibleDeleteCount === 0}
        startIcon={activeAction === 'delete' ? <CircularProgress size={14} color="inherit" /> : undefined}
        onClick={onDelete}
      >
        {activeAction === 'delete' ? 'Deleting…' : `Delete (${eligibleDeleteCount})`}
      </Button>
      <Button
        size="small"
        variant="contained"
        disabled={busy || eligibleDeductCount === 0}
        startIcon={activeAction === 'deduct' ? <CircularProgress size={14} color="inherit" /> : undefined}
        onClick={onDeduct}
      >
        {activeAction === 'deduct' ? 'Deducting…' : `Deduct inventory (${eligibleDeductCount})`}
      </Button>
    </Box>
  );
}

function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        width: '100%',
        minWidth: '100%',
        boxSizing: 'border-box',
        px: 1,
        py: 0.75,
        bgcolor: 'action.hover',
        borderBottom: 1,
        borderColor: 'divider',
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        '&:hover': { bgcolor: 'action.selected' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {collapsed ? (
        <ChevronRightIcon fontSize="small" sx={{ color: 'text.secondary' }} />
      ) : (
        <ExpandMoreIcon fontSize="small" sx={{ color: 'text.secondary' }} />
      )}
      <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', letterSpacing: '0.02em' }}>
        {label} · {count}
      </Typography>
    </Box>
  );
}

export default function FulfillmentQueue({
  toolbar,
  onAdjustmentReasonConfigured,
  onKitTypeFieldConfigured,
  pullNonce = 0,
}: {
  toolbar?: ReactNode;
  onAdjustmentReasonConfigured?: (configured: boolean | null) => void;
  onKitTypeFieldConfigured?: (configured: boolean | null) => void;
  pullNonce?: number;
}) {
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('received');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [groupBy, setGroupBy] = useState<GroupField>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [nodes, setNodes] = useState<FulfillmentSync[]>([]);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [totalCount, setTotalCount] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // Error from the last action attempted on each row, keyed by sync id. Kept separate from
  // the shared `mutationError` (which only ever reflects the single most recent call across
  // the whole page, so a bulk action — or clicking a different row right after a failure —
  // silently erases the only visible sign that a given row's action failed).
  const [rowErrors, setRowErrors] = useState<Map<number, AppError>>(new Map());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAction, setBulkAction] = useState<'deduct' | 'rematch' | 'delete' | null>(null);
  const [bulkSummary, setBulkSummary] = useState<
    | { action: 'deduct'; succeeded: number; failed: number }
    // `matched`/`stillUnmatched` are both HTTP-success outcomes of the retry call — the
    // call succeeding only means the backend re-ran matching, not that it actually found a
    // Sutton order. Distinguish them by the row's resulting status so the banner can't claim
    // rows were "rematched" when they're still sitting in an unmatched/error state.
    // `alreadyFulfilled`: the retry matched a Sutton order that is already fulfilled, so the
    // row went back to Skipped with nothing to deduct. Not "unmatched".
    | { action: 'rematch'; matched: number; stillUnmatched: number; alreadyFulfilled: number; failed: number }
    | { action: 'delete'; succeeded: number; failed: number }
    | null
  >(null);
  // "Mark errant / Un-deduct" always needs an operator-entered note (enforced server-side
  // too), so it can't fire straight from a button click like the other row actions — this
  // dialog collects it first. `null` means closed.
  const [reverseDialog, setReverseDialog] = useState<{ syncId: number; note: string } | null>(null);
  const [reverseSubmitting, setReverseSubmitting] = useState(false);
  const pullNonceRef = useRef(pullNonce);

  const qs = new URLSearchParams({
    limit: String(pageSize),
    sort: sortField,
    dir: sortDir,
    offset: String(offset),
  });
  if (statusFilter.length) qs.set('status', statusFilter.join(','));
  if (locationFilter.length) qs.set('location', locationFilter.join(','));
  if (dateFrom) qs.set('dateFrom', dateFrom);
  if (dateTo) qs.set('dateTo', dateTo);
  if (search) qs.set('q', search);
  const listPath = `/fulfillment/syncs?${qs.toString()}`;
  const hasActiveFilters =
    statusFilter.length > 0 ||
    locationFilter.length > 0 ||
    Boolean(dateFrom) ||
    Boolean(dateTo) ||
    Boolean(searchInput.trim());

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const resetPaging = useCallback(() => {
    setOffset(0);
    setSelectedIds(new Set());
  }, []);

  const filterKey = JSON.stringify({
    statusFilter,
    locationFilter,
    dateFrom,
    dateTo,
    search,
    sortField,
    sortDir,
  });
  const filterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (filterKeyRef.current === filterKey) return;
    filterKeyRef.current = filterKey;
    resetPaging();
  }, [filterKey, resetPaging]);

  const configQuery = useBackendQuery<FulfillmentConfig>({ path: '/fulfillment/config' });
  const facetsQuery = useBackendQuery<SyncFacets>({ path: '/fulfillment/syncs/facets' });
  const listQuery = useBackendQuery<SyncsPage>({ path: listPath });
  const eventsQuery = useBackendQuery<{ events: ApplyEvent[] }>({
    path: `/fulfillment/syncs/${expandedId ?? 0}/events`,
    skip: expandedId == null,
  });
  const [mutate, { error: mutationError, reset: resetMutation }] = useBackendMutation();

  const statusOptions = (
    facetsQuery.data ? STATUS_OPTIONS.filter((opt) => facetsQuery.data!.statuses.includes(opt.value)) : STATUS_OPTIONS
  ).map((opt) => ({ ...opt, count: facetsQuery.data?.statusCounts[opt.value] }));
  const locationOptions = (
    facetsQuery.data
      ? [
          ...facetsQuery.data.locations.map((value) => ({
            value,
            label: locationLabel(value, configQuery.data?.warehouseLocationCode),
          })),
          ...(facetsQuery.data.hasUnspecifiedLocation ? [{ value: '__unspecified', label: 'Unspecified' }] : []),
        ]
      : LOCATION_OPTIONS
  ).map((opt) => ({
    ...opt,
    count:
      opt.value === '__unspecified' ? facetsQuery.data?.unspecifiedLocationCount : facetsQuery.data?.locationCounts[opt.value],
  }));

  useEffect(() => {
    if (!facetsQuery.data) return;
    const allowed = new Set(facetsQuery.data.statuses);
    setStatusFilter((prev) => prev.filter((v) => allowed.has(v)));
  }, [facetsQuery.data]);

  useEffect(() => {
    if (!facetsQuery.data) return;
    const allowed = new Set(facetsQuery.data.locations);
    const includeUnspecified = facetsQuery.data.hasUnspecifiedLocation;
    setLocationFilter((prev) => prev.filter((v) => (v === '__unspecified' ? includeUnspecified : allowed.has(v))));
  }, [facetsQuery.data]);

  useEffect(() => {
    if (!listQuery.data) return;
    // The dataset can shrink out from under a page the user is sitting on (a bulk action
    // moves several rows into a filtered-out status, say) — rather than show a confusing
    // "no syncs" empty state while clearly not on page 1, step back to the previous page.
    if (listQuery.data.nodes.length === 0 && offset > 0) {
      setOffset((o) => Math.max(0, o - pageSize));
      return;
    }
    setNodes(listQuery.data.nodes);
    setTotalCount(listQuery.data.pageInfo.totalCount);
  }, [listQuery.data, offset, pageSize]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void listQuery.refetch();
      void facetsQuery.refetch();
      if (expandedId != null) void eventsQuery.refetch();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [listQuery.refetch, facetsQuery.refetch, eventsQuery.refetch, expandedId]);

  const pollStatusQuery = useBackendQuery<ReconcileStatus>({ path: '/fulfillment/reconcile' });
  useEffect(() => {
    const id = window.setInterval(() => void pollStatusQuery.refetch(), POLL_STATUS_MS);
    return () => window.clearInterval(id);
  }, [pollStatusQuery.refetch]);
  const pollStatus = pollStatusText(pollStatusQuery.data);

  const autoApply = Boolean(configQuery.data?.autoApply);
  const logSince = configQuery.data?.logSince;
  // FULFILLMENT_LOG_SINCE is a calendar date parsed as UTC midnight; local time would show the day before west of UTC.
  const logSinceLabel = formatDate(logSince, configQuery.data?.logSinceSource === 'env' ? 'UTC' : undefined);

  useEffect(() => {
    if (!configQuery.data) return;
    onAdjustmentReasonConfigured?.(configQuery.data.adjustmentReasonConfigured);
    onKitTypeFieldConfigured?.(configQuery.data.kitTypeFieldConfigured);
  }, [configQuery.data, onAdjustmentReasonConfigured, onKitTypeFieldConfigured]);

  useEffect(() => {
    if (pullNonce === pullNonceRef.current) return;
    pullNonceRef.current = pullNonce;
    resetPaging();
    void listQuery.refetch();
    void facetsQuery.refetch();
    void pollStatusQuery.refetch();
  }, [pullNonce, listQuery.refetch, facetsQuery.refetch, resetPaging]);

  // Page/rows-per-page changes also drop the current selection — a selection made on one
  // page shouldn't silently carry over to rows the user can no longer see.
  const handlePageChange = (_event: unknown, nextPage: number) => {
    setOffset(nextPage * pageSize);
    setSelectedIds(new Set());
  };
  const handleRowsPerPageChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPageSize(Number(event.target.value) || DEFAULT_PAGE_SIZE);
    setOffset(0);
    setSelectedIds(new Set());
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const toggleGroupCollapse = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Patch the mutation's own response into the current page immediately, rather than
  // waiting on `listQuery.refetch()` alone — keeps the row's displayed status in sync with
  // the action's result the instant it completes, without a round trip just to re-show
  // what the mutation already told us.
  const patchRow = (updated: FulfillmentSync | undefined) => {
    if (!updated) return;
    setNodes((prev) => (prev.some((row) => row.id === updated.id) ? prev.map((row) => (row.id === updated.id ? updated : row)) : prev));
  };

  const setRowError = (syncId: number, error: AppError | null) => {
    setRowErrors((prev) => {
      if (error == null) {
        if (!prev.has(syncId)) return prev;
        const next = new Map(prev);
        next.delete(syncId);
        return next;
      }
      const next = new Map(prev);
      next.set(syncId, error);
      return next;
    });
  };

  const runAction = async (syncId: number, action: string, body?: Record<string, unknown>) => {
    setBusyId(syncId);
    setBusyAction(action);
    resetMutation();
    const result = await mutate({
      path: `/fulfillment/syncs/${syncId}/${action}`,
      method: 'POST',
      body: body || {},
    });
    setBusyId(null);
    setBusyAction(null);
    if (!result.ok) {
      // Surface the failure right on the row the user acted on, and make sure that row is
      // expanded — clicking Approve on a collapsed row previously gave zero visible feedback
      // beyond a shared alert rendered far above the table.
      setRowError(syncId, result.error);
      setExpandedId(syncId);
      return;
    }
    setRowError(syncId, null);
    patchRow((result.data as { sync?: FulfillmentSync } | undefined)?.sync);
    await listQuery.refetch();
    void facetsQuery.refetch();
    if (expandedId === syncId) await eventsQuery.refetch();
  };

  // Closes the dialog once the call settles either way — a failure is already surfaced via
  // `runAction`'s own row-expand + rowError behavior, same as every other row action here.
  const submitReverse = async () => {
    if (!reverseDialog) return;
    const note = reverseDialog.note.trim();
    if (!note) return;
    setReverseSubmitting(true);
    await runAction(reverseDialog.syncId, 'reverse', { note });
    setReverseSubmitting(false);
    setReverseDialog(null);
  };

  const toggleRowSelected = (syncId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(syncId)) next.delete(syncId);
      else next.add(syncId);
      return next;
    });
  };

  const runBulkDeduct = async (eligibleRows: FulfillmentSync[]) => {
    if (!eligibleRows.length) return;
    setBulkBusy(true);
    setBulkAction('deduct');
    setBulkSummary(null);
    resetMutation();
    let succeeded = 0;
    let failed = 0;
    for (const row of eligibleRows) {
      setBusyId(row.id);
      setBusyAction('approve');
      const result = await mutateWithRateLimitRetry(mutate, {
        path: `/fulfillment/syncs/${row.id}/approve`,
        method: 'POST',
        body: {},
      });
      if (result.ok) {
        succeeded += 1;
        setRowError(row.id, null);
        patchRow((result.data as { sync?: FulfillmentSync } | undefined)?.sync);
      } else {
        failed += 1;
        // The "N order(s) failed" banner only gives a count — tag the specific row(s) so
        // expanding one actually shows why, instead of making the user guess which of the
        // selected rows is the failing one.
        setRowError(row.id, result.error);
      }
      await sleep(BULK_ACTION_DELAY_MS);
    }
    setBusyId(null);
    setBusyAction(null);
    setBulkBusy(false);
    setBulkAction(null);
    setSelectedIds(new Set());
    setBulkSummary({ action: 'deduct', succeeded, failed });
    await listQuery.refetch();
    void facetsQuery.refetch();
  };

  const runBulkRematch = async (eligibleRows: FulfillmentSync[]) => {
    if (!eligibleRows.length) return;
    setBulkBusy(true);
    setBulkAction('rematch');
    setBulkSummary(null);
    resetMutation();
    let matched = 0;
    let stillUnmatched = 0;
    let alreadyFulfilled = 0;
    let failed = 0;
    for (const row of eligibleRows) {
      setBusyId(row.id);
      setBusyAction('retry');
      const result = await mutateWithRateLimitRetry(mutate, {
        path: `/fulfillment/syncs/${row.id}/retry`,
        method: 'POST',
        body: {},
      });
      if (result.ok) {
        setRowError(row.id, null);
        // The call succeeding only means the backend re-ran the match attempt, not that it
        // actually found a Sutton order — check the row's resulting status to tell the two apart.
        const updated = (result.data as { sync?: FulfillmentSync } | undefined)?.sync;
        patchRow(updated);
        if (updated && !REMATCH_STATUSES.has(updated.status)) {
          matched += 1;
        } else if (updated?.status === 'skipped' && updated.error_code === 'ALREADY_FULFILLED_IN_SUTTON') {
          alreadyFulfilled += 1;
        } else {
          stillUnmatched += 1;
        }
      } else {
        failed += 1;
        setRowError(row.id, result.error);
      }
      await sleep(BULK_ACTION_DELAY_MS);
    }
    setBusyId(null);
    setBusyAction(null);
    setBulkBusy(false);
    setBulkAction(null);
    setSelectedIds(new Set());
    setBulkSummary({ action: 'rematch', matched, stillUnmatched, alreadyFulfilled, failed });
    await listQuery.refetch();
    void facetsQuery.refetch();
  };

  const runBulkDelete = async (eligibleRows: FulfillmentSync[]) => {
    if (!eligibleRows.length) return;
    setBulkBusy(true);
    setBulkAction('delete');
    setBulkSummary(null);
    resetMutation();
    let succeeded = 0;
    let failed = 0;
    for (const row of eligibleRows) {
      setBusyId(row.id);
      setBusyAction('delete');
      const result = await mutateWithRateLimitRetry(mutate, {
        path: `/fulfillment/syncs/${row.id}/delete`,
        method: 'POST',
        body: {},
      });
      if (result.ok) {
        succeeded += 1;
        setRowError(row.id, null);
        setNodes((prev) => prev.filter((node) => node.id !== row.id));
      } else {
        failed += 1;
        setRowError(row.id, result.error);
      }
      await sleep(BULK_ACTION_DELAY_MS);
    }
    setBusyId(null);
    setBusyAction(null);
    setBulkBusy(false);
    setBulkAction(null);
    setSelectedIds(new Set());
    setBulkSummary({ action: 'delete', succeeded, failed });
    await listQuery.refetch();
    void facetsQuery.refetch();
  };

  const rows = nodes;

  const groups = (() => {
    if (groupBy === 'none') return [{ key: '__all', label: '', rows }];
    const map = new Map<string, FulfillmentSync[]>();
    for (const row of rows) {
      const key = groupBy === 'status' ? row.status : row.warehouse_location || '__unspecified';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return Array.from(map.entries()).map(([key, groupRows]) => {
      const label =
        groupBy === 'status'
          ? STATUS_OPTIONS.find((o) => o.value === key)?.label || key.replaceAll('_', ' ')
          : key === '__unspecified'
            ? 'Unspecified'
            : locationLabel(key, configQuery.data?.warehouseLocationCode);
      return { key, label, rows: groupRows };
    });
  })();

  const selectedRows = rows.filter((row) => selectedIds.has(row.id));
  const eligibleSelectedRows = selectedRows.filter(isDeductEligible);
  const rematchEligibleSelectedRows = selectedRows.filter(isRematchEligible);
  const deleteEligibleSelectedRows = selectedRows.filter(isDeleteEligible);
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.has(row.id));
  const someSelected = !allSelected && rows.some((row) => selectedIds.has(row.id));
  const toggleAllSelected = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((row) => row.id)));
  };

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'flex-end' } }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: '0.16em' }}>
            WooCommerce → Sutton
          </Typography>
          <Typography variant="h5" component="h1" sx={{ fontWeight: 650, letterSpacing: '-0.02em' }}>
            Fulfillment log
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5, maxWidth: 640 }}>
            {autoApply
              ? 'Open Sutton sales orders from WooCommerce wait here as Awaiting completion. Once WooCommerce marks an order Completed, its stock is deducted automatically. Failures and partial applies stay in this log.'
              : 'Open Sutton sales orders from WooCommerce wait here as Awaiting completion. Once WooCommerce marks an order Completed, it moves to Pending approval for Approve.'}
          </Typography>
        </Box>
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ alignItems: 'center', flexWrap: 'wrap', justifyContent: { xs: 'flex-start', sm: 'flex-end' } }}
        >
          {toolbar}
        </Stack>
      </Stack>

      {logSince || pollStatus ? (
        <Stack spacing={0.25} sx={{ mb: 1.5 }}>
          {logSince ? (
            <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
              Showing orders received since {logSinceLabel}
              {configQuery.data?.logSinceSource === 'env'
                ? ' (set by FULFILLMENT_LOG_SINCE).'
                : ' (default: when the WooCommerce poll started).'}{' '}
              See Secrets and Capabilities for more info.
            </Typography>
          ) : null}
          {pollStatus ? (
            <Typography variant="caption" component="p" sx={{ color: 'text.secondary' }}>
              {pollStatus}
            </Typography>
          ) : null}
        </Stack>
      ) : null}

      <FiltersBar
        statusOptions={statusOptions}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        locationOptions={locationOptions}
        locationFilter={locationFilter}
        onLocationFilterChange={setLocationFilter}
        search={searchInput}
        onSearchChange={setSearchInput}
        dateFrom={dateFrom}
        onDateFromChange={setDateFrom}
        dateTo={dateTo}
        onDateToChange={setDateTo}
        groupBy={groupBy}
        onGroupByChange={(next) => {
          setCollapsedGroups(new Set());
          setGroupBy(next);
        }}
        onClear={() => {
          setStatusFilter([]);
          setLocationFilter([]);
          setDateFrom('');
          setDateTo('');
          setSearchInput('');
          setSearch('');
        }}
        hasActiveFilters={hasActiveFilters}
      />

      {selectedIds.size > 0 ? (
        <BulkActionBar
          selectedCount={selectedRows.length}
          eligibleDeductCount={eligibleSelectedRows.length}
          eligibleRematchCount={rematchEligibleSelectedRows.length}
          eligibleDeleteCount={deleteEligibleSelectedRows.length}
          busy={bulkBusy}
          activeAction={bulkAction}
          onDeduct={() => void runBulkDeduct(eligibleSelectedRows)}
          onRematch={() => void runBulkRematch(rematchEligibleSelectedRows)}
          onDelete={() => void runBulkDelete(deleteEligibleSelectedRows)}
          onClear={() => setSelectedIds(new Set())}
        />
      ) : null}

      {bulkSummary && bulkSummary.action === 'rematch' ? (
        <Alert
          severity={bulkSummary.failed || bulkSummary.stillUnmatched ? 'warning' : 'success'}
          onClose={() => setBulkSummary(null)}
        >
          {bulkSummary.matched
            ? `${bulkSummary.matched} order${bulkSummary.matched === 1 ? '' : 's'} matched. `
            : ''}
          {bulkSummary.stillUnmatched
            ? `${bulkSummary.stillUnmatched} order${
                bulkSummary.stillUnmatched === 1 ? '' : 's'
              } remain unmatched. `
            : ''}
          {bulkSummary.alreadyFulfilled
            ? `${bulkSummary.alreadyFulfilled} order${
                bulkSummary.alreadyFulfilled === 1 ? ' is' : 's are'
              } already fulfilled in Sutton and stay skipped. `
            : ''}
          {bulkSummary.failed
            ? `${bulkSummary.failed} order${bulkSummary.failed === 1 ? '' : 's'} failed — expand the row for details.`
            : ''}
          {!bulkSummary.matched && !bulkSummary.stillUnmatched && !bulkSummary.alreadyFulfilled && !bulkSummary.failed
            ? 'No orders were eligible to retry.'
            : ''}
        </Alert>
      ) : null}
      {bulkSummary && bulkSummary.action === 'deduct' ? (
        <Alert
          severity={bulkSummary.failed ? 'warning' : 'success'}
          onClose={() => setBulkSummary(null)}
        >
          {bulkSummary.succeeded
            ? `${bulkSummary.succeeded} order${bulkSummary.succeeded === 1 ? '' : 's'} sent for inventory deduction. `
            : ''}
          {bulkSummary.failed
            ? `${bulkSummary.failed} order${bulkSummary.failed === 1 ? '' : 's'} failed — expand the row for details.`
            : ''}
        </Alert>
      ) : null}

      {bulkSummary && bulkSummary.action === 'delete' ? (
        <Alert
          severity={bulkSummary.failed ? 'warning' : 'success'}
          onClose={() => setBulkSummary(null)}
        >
          {bulkSummary.succeeded
            ? `${bulkSummary.succeeded} skipped order${bulkSummary.succeeded === 1 ? '' : 's'} deleted. `
            : ''}
          {bulkSummary.failed
            ? `${bulkSummary.failed} order${bulkSummary.failed === 1 ? '' : 's'} failed to delete — expand the row for details.`
            : ''}
        </Alert>
      ) : null}

      {configQuery.data && !configQuery.data.warehouseLocationConfigured ? (
        <Alert severity="warning">
          {configQuery.data.warehouseLocationError
            ? configQuery.data.warehouseLocationError
            : configQuery.data.warehouseLocationId
              ? 'The fulfillment warehouse is not a warehouse location in Sutton. Open the Configuration tab and choose another. Applies stay blocked until then.'
              : 'No fulfillment warehouse is selected. Open the Configuration tab and choose the warehouse every order deducts from. Applies stay blocked until then.'}
        </Alert>
      ) : null}

      {configQuery.error ? (
        <AppErrorAlert error={configQuery.error} onRetry={() => void configQuery.refetch()} />
      ) : null}
      {listQuery.error ? (
        <AppErrorAlert error={listQuery.error} onRetry={() => void listQuery.refetch()} />
      ) : null}
      {mutationError ? <AppErrorAlert error={mutationError} /> : null}

      {/* The list refetches every few seconds; only the first load shows "Loading", so an empty log doesn't flash. */}
      {listQuery.data === undefined && !listQuery.error ? (
        <Typography sx={{ color: 'text.secondary' }}>Loading log…</Typography>
      ) : null}
      {listQuery.data !== undefined && rows.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>
          {logSince
            ? `No syncs for orders received since ${logSinceLabel}.`
            : 'No orders yet. Every 20 minutes the poll adds open Sutton sales orders from WooCommerce and checks WooCommerce for completed orders. Use Run now on the Configuration tab to run it right away.'}
        </Typography>
      ) : null}

      {rows.length > 0 ? (
        <Box
          sx={{
            borderTop: 1,
            borderColor: 'divider',
            overflowX: 'auto',
          }}
        >
          <Box sx={{ minWidth: 852 }}>
            <QueueHeader
              sortField={sortField}
              sortDir={sortDir}
              onSort={handleSort}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleAll={toggleAllSelected}
            />
            {groups.map((group) => {
              const collapsed = groupBy !== 'none' && collapsedGroups.has(group.key);
              return (
                <Box key={group.key} sx={{ width: '100%' }}>
                  {groupBy !== 'none' ? (
                    <GroupHeader
                      label={group.label}
                      count={group.rows.length}
                      collapsed={collapsed}
                      onToggle={() => toggleGroupCollapse(group.key)}
                    />
                  ) : null}
                  {collapsed
                    ? null
                    : group.rows.map((sync) => (
                        <SyncRow
                          key={sync.id}
                          sync={sync}
                          expanded={expandedId === sync.id}
                          busy={busyId === sync.id}
                          activeAction={busyId === sync.id ? busyAction : null}
                          autoApply={autoApply}
                          virtualKitsEnabled={configQuery.data?.kitTypeFieldConfigured === true}
                          defaultBinCode={configQuery.data?.warehouseLocationCode ?? null}
                          events={expandedId === sync.id ? eventsQuery.data?.events : undefined}
                          rowError={rowErrors.get(sync.id)}
                          selected={selectedIds.has(sync.id)}
                          selectDisabled={bulkBusy}
                          onToggle={() => setExpandedId((id) => (id === sync.id ? null : sync.id))}
                          onToggleSelect={() => toggleRowSelected(sync.id)}
                          onAction={(path, body) => void runAction(sync.id, path, body)}
                          onRequestReverse={() => setReverseDialog({ syncId: sync.id, note: '' })}
                        />
                      ))}
                </Box>
              );
            })}
          </Box>
          <TablePagination
            component="div"
            count={totalCount}
            page={pageSize > 0 ? Math.floor(offset / pageSize) : 0}
            onPageChange={handlePageChange}
            rowsPerPage={pageSize}
            onRowsPerPageChange={handleRowsPerPageChange}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            // Matches Sutton's own tables: no "Rows per page" label ahead of the size select.
            labelRowsPerPage=""
            sx={{ borderTop: 1, borderColor: 'divider' }}
          />
        </Box>
      ) : null}
      <Dialog open={reverseDialog != null} onClose={() => setReverseDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Mark errant and un-deduct</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
            Issues a compensating adjustment to give back the inventory this order deducted.
            The Sutton order's status is left as-is — only the stock is reversed. This cannot
            be undone from here.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            label="Why is this errant?"
            placeholder="e.g. Duplicate order, wrong item shipped, customer cancelled after fulfillment…"
            value={reverseDialog?.note ?? ''}
            onChange={(event) =>
              setReverseDialog((prev) => (prev ? { ...prev, note: event.target.value } : prev))
            }
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReverseDialog(null)} disabled={reverseSubmitting}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={reverseSubmitting || !reverseDialog?.note.trim()}
            startIcon={actionIcon(reverseSubmitting)}
            onClick={() => void submitReverse()}
          >
            {reverseSubmitting ? 'Undoing deduction…' : 'Undo deduction'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
