import { useState } from 'react';

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

import { AppErrorAlert, useBackendMutation, useBackendQuery } from '@heysutton/sdk-react';

import { parseTimestamp, type ReconcileStatus } from '../types';
import { Subsection } from './SectionHeader';

function formatDateTime(epochMs: number | null | undefined) {
  if (!epochMs) return '—';
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function runSummaryText(run: ReconcileStatus['recentRuns'][number]) {
  const result = run.result;
  if (run.status === 'failed') return run.error || 'Failed.';
  if (!result) return run.status === 'running' ? 'Running…' : 'No result yet.';
  return (
    `WooCommerce: scanned ${result.scanned}, completed ${result.completed ?? 0}, queued ${result.queued}, ` +
    `unmatched ${result.unmatched}, already tracked ${result.skippedExisting}. ` +
    `Sutton: open ${result.suttonOpen ?? 0}, awaiting added ${result.awaitingAdded ?? 0}, ` +
    `closed before completion ${result.suttonClosed ?? 0}` +
    (result.suttonDeferred ? `, deferred ${result.suttonDeferred}` : '') +
    (result.alreadyFulfilled ? `, already fulfilled in Sutton ${result.alreadyFulfilled}` : '') +
    (result.pendingDeducted ? `, pending approval deducted ${result.pendingDeducted}` : '') +
    (result.pendingDeferred ? `, pending approval left for next run ${result.pendingDeferred}` : '') +
    (result.restockDeducted ? `, restocked and deducted ${result.restockDeducted}` : '') +
    (result.restockReady ? `, restocked and ready to retry ${result.restockReady}` : '') +
    (result.restockStillShort ? `, still short of stock ${result.restockStillShort}` : '') +
    (result.retried ? `, retried ${result.retried}` : '') +
    (result.deferred ? `, deferred to next tick ${result.deferred}` : '') +
    (result.pageLimitReached ? `, stopped at the ${result.pagesFetched ?? ''}-page limit` : '') +
    (result.deduped ? `, duplicates cleared ${result.deduped}` : '') +
    (result.errors?.length ? `, errors ${result.errors.length}` : '')
  );
}

function formatIso(iso: string | null | undefined) {
  if (!iso) return null;
  const d = parseTimestamp(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

export default function PullFromWooCommerce({ onPulled }: { onPulled: () => void }) {
  const [running, setRunning] = useState(false);

  const statusQuery = useBackendQuery<ReconcileStatus>({ path: '/fulfillment/reconcile' });
  const [runNow, { error: runError, reset: resetRunError }] = useBackendMutation<{ runId: string }>();

  const config = statusQuery.data?.config;
  const schedule = statusQuery.data?.schedule;
  const recentRuns = statusQuery.data?.recentRuns ?? [];
  const connectionReady = Boolean(config?.wooCommerceConfigured);
  const cursorText = formatIso(config?.wcPollCursor);
  const latestResult = recentRuns.find((run) => run.result)?.result;

  const handleRunNow = async () => {
    setRunning(true);
    resetRunError();
    const result = await runNow({ path: '/fulfillment/reconcile-now', method: 'POST' });
    setRunning(false);
    if (result.ok) {
      await statusQuery.refetch();
      onPulled();
    }
  };

  return (
    <Subsection
      title="WooCommerce poll"
      description={
        <>
          Reads WooCommerce every {schedule ? Math.round(schedule.everySeconds / 60) : 20} minutes. Each run:
          <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
            <li>
              Moves orders WooCommerce has completed from Awaiting completion to Pending approval, or
              deducts them when automated deductions are on.
            </li>
            <li>Marks completed orders with no Sutton order yet Unmatched, and retries them later.</li>
            <li>
              Adds open Sutton sales orders from WooCommerce as Awaiting completion, and marks Skipped any
              whose Sutton order was fulfilled, cancelled, or deleted first.
            </li>
          </Box>
          Each run reads up to {config?.wcPollMaxPages ?? 250} pages of 100 orders and handles up to 50.
          The rest is picked up on the next run.
        </>
      }
    >
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' } }}>
        <Typography variant="body2">
          Next run: {formatDateTime(schedule?.nextDueAt)}
          {schedule?.autoPaused ? ' — paused after repeated failures' : ''}
        </Typography>
        <Button
          variant="contained"
          size="small"
          disabled={running || !connectionReady}
          onClick={() => void handleRunNow()}
        >
          {running ? 'Running…' : 'Run now'}
        </Button>
      </Stack>
      {!connectionReady && config ? (
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
          WooCommerce REST is not configured. Add WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET in
          Settings in Sutton Studio.
        </Typography>
      ) : null}
      {connectionReady ? (
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
          {cursorText
            ? `Polled through orders modified ${cursorText}.`
            : 'Not polled yet. The first run looks back 48 hours, or from the log start date when one is set.'}
        </Typography>
      ) : null}
      {latestResult?.pageLimitReached ? (
        <Alert severity="info" sx={{ mt: 1 }}>
          The last run stopped at the {config?.wcPollMaxPages ?? 250}-page limit. The next run resumes from
          where it stopped.
        </Alert>
      ) : null}
      {recentRuns.length ? (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mb: 0.5 }}>
            Recent runs
          </Typography>
          <Stack spacing={0.5}>
            {recentRuns.map((run) => (
              <Typography key={run.runId} variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                {formatDateTime(run.endedAt ?? run.startedAt ?? run.createdAt)} ({run.kind}) — {runSummaryText(run)}
              </Typography>
            ))}
          </Stack>
        </Box>
      ) : null}
      {runError ? (
        <Box sx={{ mt: 1 }}>
          <AppErrorAlert error={runError} />
        </Box>
      ) : null}
    </Subsection>
  );
}
