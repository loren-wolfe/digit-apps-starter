import { AppErrorCode, parseJsonResponse } from '@heysutton/sdk';
import { appJobs, err, ok } from '@heysutton/sdk-server';

import { POLL_JOB_NAME } from './config.js';
import { dbAdapter } from './db.js';
import { createFulfillment, syncSinceSql } from './service.js';
import { isWooCommerceConfigured } from './woocommerce.js';

const CONFLICT_CODES = new Set([
  'AWAITING_COMPLETION',
  'INVALID_STATUS',
  'IN_PROGRESS',
  'STOCK_SHORTAGE',
  'PARTIAL_APPLY',
  'ALREADY_APPLIED',
  'DRY_RUN_DISABLED',
]);

function mapError(errObj) {
  const code = errObj.code || AppErrorCode.SERVER_ERROR;
  if (code === 'CONFIG_MISSING') {
    return err({ code: AppErrorCode.MISSING_CONFIG, message: errObj.message, status: 503 });
  }
  if (code === 'SUTTON_API' || code === 'WC_API') {
    return err({ code: AppErrorCode.UPSTREAM_ERROR, message: errObj.message, status: 502 });
  }
  if (CONFLICT_CODES.has(code)) {
    return err({ code: AppErrorCode.VALIDATION_ERROR, message: errObj.message, status: 409 });
  }
  if (code === 'NOT_FOUND') {
    return err({ code: AppErrorCode.NOT_FOUND, message: errObj.message, status: 404 });
  }
  return err({ code: AppErrorCode.SERVER_ERROR, message: errObj.message, status: 500 });
}

// D1 is SQLite: regexp_replace and `::numeric` are Postgres-only and make the
// Sutton-order sort fail with "no such function: regexp_replace".
function sqliteNumericOrderKey(column) {
  let expr = `UPPER(IFNULL(${column}, ''))`;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ-') {
    expr = `REPLACE(${expr}, '${ch}', '')`;
  }
  return `CAST(NULLIF(${expr}, '') AS INTEGER)`;
}

function parseId(part) {
  const id = Number(part);
  if (!Number.isInteger(id) || id < 1) return null;
  return id;
}

export async function handleFulfillment({ request, env, path, method }) {
  const fulfillment = createFulfillment(env);
  const db = dbAdapter(env);

  if (method === 'GET' && path === '/health') {
    const cfg = await fulfillment.getFulfillmentConfig();
    return ok({
      data: {
        ok: true,
        autoApply: cfg.autoApply,
        warehouseLocationConfigured: cfg.warehouseLocationConfigured,
        adjustmentReasonConfigured: cfg.adjustmentReasonConfigured,
      },
    });
  }

  if (method === 'GET' && path === '/fulfillment/config') {
    return ok({ data: await fulfillment.getFulfillmentConfig() });
  }

  // Operator-togglable automated deductions (fulfillment_settings). This is the only
  // auto-apply control for the scheduled poll and for single-row Retry. Read: anyone with access to
  // the app. Write: this Worker has no per-request user identity to check server-side (every
  // Sutton call here goes out under the app's own API_TOKEN_SUTTON, not the calling operator's
  // session), so the gate for who can SEE/toggle it lives client-side (App.tsx's
  // `canToggleAutoDeduct`, checking UPDATE_ORGANIZATION/UPDATE_ORDER/UPDATE_INVENTORY via the
  // Digit GraphQL API using the operator's own session — deliberately looser than full
  // org-settings admin, since this is an operational toggle, not an org-settings change).
  // Toggling this does not call Sutton at all, so it carries materially lower risk than, say,
  // approving a deduction — if a stronger server-side gate is needed later, it belongs here.
  if (method === 'GET' && path === '/fulfillment/auto-deduct') {
    return ok({ data: await fulfillment.getAutoDeductStatus() });
  }

  if (method === 'POST' && path === '/fulfillment/warehouse') {
    const parsed = await parseJsonResponse({ value: request.json().catch(() => ({})) });
    const body = parsed.ok ? parsed.value || {} : {};
    const warehouseLocationId = String(body.warehouseLocationId || '').trim();
    if (!warehouseLocationId) {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: 'Choose a warehouse location.',
        status: 400,
      });
    }
    try {
      const config = await fulfillment.setWarehouseLocation(warehouseLocationId);
      return ok({ data: config });
    } catch (e) {
      if (e.code === 'LOCATION_UNRESOLVED' || e.code === 'CONFIG_MISSING') {
        return err({
          code: AppErrorCode.VALIDATION_ERROR,
          message: e.message,
          status: 400,
        });
      }
      return mapError(e);
    }
  }

  if (method === 'POST' && path === '/fulfillment/auto-deduct') {
    const parsed = await parseJsonResponse({ value: request.json().catch(() => ({})) });
    const body = parsed.ok ? parsed.value || {} : {};
    if (typeof body.enabled !== 'boolean') {
      return err({
        code: AppErrorCode.VALIDATION_ERROR,
        message: '"enabled" (boolean) is required.',
        status: 400,
      });
    }
    try {
      const status = await fulfillment.setAutoDeduct(body.enabled, { by: body.by || null });
      return ok({ data: status });
    } catch (e) {
      return mapError(e);
    }
  }

  if (method === 'GET' && path === '/fulfillment/syncs/facets') {
    await fulfillment.consolidateDuplicateSyncs();
    const url = new URL(request.url);
    const errorsOnly = url.searchParams.get('errors') === 'true';
    const { since: logSince } = await fulfillment.getLogSince();

    const clauses = [];
    const params = [];
    if (errorsOnly) {
      clauses.push(
        `(status IN ('needs_attention', 'failed', 'unmatched', 'missing_address') OR (status = 'pending_approval' AND error IS NOT NULL))`,
      );
    }
    if (logSince) {
      params.push(logSince);
      clauses.push(syncSinceSql(params.length));
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';

    const [statusRows, locationRows] = await Promise.all([
      db.query(`SELECT status, COUNT(*) AS count FROM fulfillment_syncs${where} GROUP BY status`, params),
      db.query(
        `SELECT warehouse_location, COUNT(*) AS count FROM fulfillment_syncs${where} GROUP BY warehouse_location`,
        params,
      ),
    ]);

    const statuses = statusRows.rows.map((row) => row.status).filter(Boolean).sort();
    const statusCounts = Object.fromEntries(
      statusRows.rows.filter((row) => row.status).map((row) => [row.status, Number(row.count)]),
    );
    const hasUnspecifiedLocation = locationRows.rows.some((row) => !row.warehouse_location);
    const unspecifiedLocationCount = locationRows.rows
      .filter((row) => !row.warehouse_location)
      .reduce((sum, row) => sum + Number(row.count), 0);
    const locations = locationRows.rows
      .map((row) => row.warehouse_location)
      .filter(Boolean)
      .sort();
    const locationCounts = Object.fromEntries(
      locationRows.rows.filter((row) => row.warehouse_location).map((row) => [row.warehouse_location, Number(row.count)]),
    );

    return ok({
      data: {
        statuses,
        statusCounts,
        locations,
        locationCounts,
        hasUnspecifiedLocation,
        unspecifiedLocationCount,
      },
    });
  }

  if (method === 'GET' && path === '/fulfillment/syncs') {
    await fulfillment.consolidateDuplicateSyncs();
    const url = new URL(request.url);
    // Capped well above the largest page-size option the UI offers (250), so picking that
    // option doesn't get silently clamped down to a smaller page than what's displayed.
    const limit = Math.min(Number(url.searchParams.get('limit') || 25) || 25, 500);
    const splitCsv = (key) =>
      (url.searchParams.get(key) || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    const statuses = splitCsv('status');
    const locations = splitCsv('location');
    const errorsOnly = url.searchParams.get('errors') === 'true';
    const offset = Math.max(Number(url.searchParams.get('offset') || 0) || 0, 0);
    const dateFrom = url.searchParams.get('dateFrom');
    const dateTo = url.searchParams.get('dateTo');
    const sortParam = url.searchParams.get('sort');
    const sort = ['updated', 'status', 'location', 'so'].includes(sortParam) ? sortParam : 'received';
    const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
    const { since: logSince } = await fulfillment.getLogSince();

    const clauses = [];
    const params = [];
    if (errorsOnly) {
      clauses.push(
        `(status IN ('needs_attention', 'failed', 'unmatched', 'missing_address') OR (status = 'pending_approval' AND error IS NOT NULL))`,
      );
    }
    if (statuses.length) {
      params.push(statuses);
      clauses.push(`status = ANY($${params.length})`);
    }
    if (!statuses.includes('removed')) {
      clauses.push(`status != 'removed'`);
    }
    if (locations.length) {
      const realLocations = locations.filter((loc) => loc !== '__unspecified');
      const includeUnspecified = locations.includes('__unspecified');
      const sub = [];
      if (realLocations.length) {
        params.push(realLocations);
        sub.push(`warehouse_location = ANY($${params.length})`);
      }
      if (includeUnspecified) sub.push('warehouse_location IS NULL');
      if (sub.length) clauses.push(`(${sub.join(' OR ')})`);
    }
    if (logSince) {
      params.push(logSince);
      clauses.push(syncSinceSql(params.length));
    }
    if (dateFrom) {
      params.push(dateFrom);
      clauses.push(`datetime(order_received_date) >= datetime($${params.length})`);
    }
    if (dateTo) {
      params.push(dateTo);
      // The date input is a calendar day. A timestamp on that day sorts after the bare date,
      // so the bound is the start of the next day.
      clauses.push(`datetime(order_received_date) < datetime($${params.length}, '+1 day')`);
    }
    const search = (url.searchParams.get('q') || '').trim().replace(/^#/, '').slice(0, 100);
    if (search) {
      params.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      const n = params.length;
      clauses.push(
        `(order_number LIKE $${n} ESCAPE '\\' OR CAST(wc_order_id AS TEXT) LIKE $${n} ESCAPE '\\' OR digit_order_number LIKE $${n} ESCAPE '\\')`,
      );
    }
    const whereSql = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM fulfillment_syncs${whereSql}`;
    const dirSql = dir === 'asc' ? 'ASC' : 'DESC';
    if (sort === 'updated') {
      sql += ` ORDER BY updated_at ${dirSql}, id ${dirSql}`;
    } else if (sort === 'status') {
      sql += ` ORDER BY status ${dirSql}, updated_at DESC, id DESC`;
    } else if (sort === 'location') {
      sql += ` ORDER BY (warehouse_location IS NULL), warehouse_location ${dirSql}, updated_at DESC, id DESC`;
    } else if (sort === 'so') {
      // SO numbers are stored as text ("10452", "SO-99"). Sort on the numeric portion so
      // 100 follows 99, and keep rows with no Sutton order at the end either direction.
      sql += ` ORDER BY (digit_order_number IS NULL), ${sqliteNumericOrderKey('digit_order_number')} ${dirSql}, digit_order_number ${dirSql}, updated_at DESC, id DESC`;
    } else {
      sql += ` ORDER BY (order_received_date IS NULL), order_received_date ${dirSql}, updated_at DESC, id DESC`;
    }
    const pageParams = [...params, limit + 1, offset];
    sql += ` LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`;

    // Jump-to-page / jump-to-last-page in the UI needs a real total, not just "is there a
    // next page" — reuse the same WHERE clause (and its params) against COUNT(*) rather than
    // paging through everything to find the end.
    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query(sql, pageParams),
      db.query(`SELECT COUNT(*) AS count FROM fulfillment_syncs${whereSql}`, params),
    ]);
    const totalCount = Number(countRows[0]?.count || 0);
    const hasMore = rows.length > limit;
    const nodes = hasMore ? rows.slice(0, limit) : rows;
    return ok({
      data: {
        nodes,
        pageInfo: { hasMore, limit, totalCount },
      },
    });
  }

  if (method === 'GET' && path === '/fulfillment/log') {
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get('limit') || 50) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get('offset') || 0) || 0, 0);
    const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
    const page = await fulfillment.listActivityLog({ limit, offset, dir });
    return ok({ data: page });
  }

  const eventsMatch = path.match(/^\/fulfillment\/syncs\/(\d+)\/events$/);
  if (method === 'GET' && eventsMatch) {
    const id = parseId(eventsMatch[1]);
    if (!id) return err({ code: AppErrorCode.VALIDATION_ERROR, message: 'Invalid sync id.', status: 400 });
    const events = await fulfillment.listApplyEvents(id);
    return ok({ data: { events } });
  }

  const actionMatch = path.match(/^\/fulfillment\/syncs\/(\d+)\/([a-z-]+)$/);
  if (method === 'POST' && actionMatch) {
    const id = parseId(actionMatch[1]);
    const action = actionMatch[2];
    if (!id) return err({ code: AppErrorCode.VALIDATION_ERROR, message: 'Invalid sync id.', status: 400 });

    const parsed = await parseJsonResponse({ value: request.json().catch(() => ({})) });
    const body = parsed.ok ? parsed.value || {} : {};

    try {
      let result;
      if (action === 'approve') {
        result = await fulfillment.approveSync(id, { approvedBy: body.approvedBy, dryRun: !!body.dryRun });
      } else if (action === 'apply') {
        result = await fulfillment.applyFulfillment(id, {
          trigger: body.trigger || 'manual',
          approvedBy: body.approvedBy,
          dryRun: !!body.dryRun,
        });
      } else if (action === 'resume') {
        result = await fulfillment.resumeApply(id, { approvedBy: body.approvedBy });
      } else if (action === 'recheck-stock') {
        result = await fulfillment.recheckStock(id);
      } else if (action === 'retry-order-status') {
        result = await fulfillment.retryOrderStatus(id, { approvedBy: body.approvedBy });
      } else if (action === 'resolve') {
        result = await fulfillment.markResolved(id, { note: body.note });
      } else if (action === 'reject') {
        result = await fulfillment.rejectSync(id, { note: body.note });
      } else if (action === 'retry') {
        result = await fulfillment.retrySync(id);
      } else if (action === 'unskip') {
        result = await fulfillment.unskipSync(id, { note: body.note });
      } else if (action === 'remove') {
        result = await fulfillment.removeUnmatchedSync(id);
      } else if (action === 'restore') {
        result = await fulfillment.restoreRemovedSync(id);
      } else if (action === 'reverse') {
        if (!String(body.note || '').trim()) {
          return err({
            code: AppErrorCode.VALIDATION_ERROR,
            message: 'A note is required to mark a sync errant and un-deduct its inventory.',
            status: 400,
          });
        }
        result = await fulfillment.reverseSync(id, { note: body.note, approvedBy: body.approvedBy });
      } else if (action === 'rerun') {
        result = await fulfillment.rerunReversedSync(id, { approvedBy: body.approvedBy });
      } else if (action === 'delete') {
        const deleted = await fulfillment.deleteSync(id);
        if (!deleted) {
          return err({ code: AppErrorCode.NOT_FOUND, message: 'Sync not found.', status: 404 });
        }
        return ok({ data: deleted });
      } else {
        return null;
      }
      if (!result) {
        return err({ code: AppErrorCode.NOT_FOUND, message: 'Sync not found.', status: 404 });
      }
      return ok({ data: { sync: result.sync || result, ...result } });
    } catch (e) {
      return mapError(e);
    }
  }

  if (method === 'GET' && path === '/fulfillment/reconcile') {
    const jobs = appJobs({ env });
    const [schedules, recentRuns, config] = await Promise.all([
      jobs.schedules(),
      jobs.list({ limit: 5 }),
      fulfillment.getFulfillmentConfig(),
    ]);
    return ok({
      data: {
        schedule: schedules.find((s) => s.name === POLL_JOB_NAME) || null,
        recentRuns,
        config,
      },
    });
  }

  // Operator-triggered immediate check — the scheduled "woocommerce-poll" job otherwise
  // runs every 20 minutes on its own; this just asks the platform to run it now too.
  if (method === 'POST' && path === '/fulfillment/reconcile-now') {
    if (!isWooCommerceConfigured(env)) {
      return mapError({
        code: 'CONFIG_MISSING',
        message:
          'WooCommerce REST is not configured. Set WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET in Settings in Sutton Studio.',
      });
    }
    try {
      const { runId } = await appJobs({ env }).submit({ name: POLL_JOB_NAME });
      return ok({ data: { runId }, status: 202 });
    } catch (e) {
      return mapError(e);
    }
  }

  return null;
}
