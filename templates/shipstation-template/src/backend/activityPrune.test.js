import assert from 'node:assert/strict';
import test from 'node:test';

import { isActivityPruneWindow, pacificDate, pruneActivityLog } from './activity.js';

test('the prune window is the first 10 minutes after midnight Pacific', () => {
  assert.equal(isActivityPruneWindow(new Date('2026-09-23T07:00:00.000Z')), true);
  assert.equal(isActivityPruneWindow(new Date('2026-09-23T07:09:00.000Z')), true);
  assert.equal(isActivityPruneWindow(new Date('2026-09-23T07:10:00.000Z')), false);
  assert.equal(isActivityPruneWindow(new Date('2026-09-23T06:59:00.000Z')), false);
});

test('pacific dates follow the same clock as the nightly window', () => {
  assert.equal(pacificDate(new Date('2026-09-23T07:00:00.000Z')), '2026-09-23');
  assert.equal(pacificDate(new Date('2026-09-23T18:00:00.000Z')), '2026-09-23');
  assert.equal(pacificDate(new Date('2026-01-15T08:02:00.000Z')), '2026-01-15');
});

test('winter midnight is Pacific standard time', () => {
  assert.equal(isActivityPruneWindow(new Date('2026-01-15T08:02:00.000Z')), true);
  assert.equal(isActivityPruneWindow(new Date('2026-01-15T07:30:00.000Z')), false);
});

test('prune deletes rows older than one month only inside the window', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(age) {
          return {
            async run() {
              calls.push({ sql, age });
              return { meta: { changes: 4 } };
            },
          };
        },
      };
    },
  };

  const skipped = await pruneActivityLog({ db, now: new Date('2026-09-23T18:00:00.000Z') });
  assert.deepEqual(skipped, { deleted: 0, skipped: true });
  assert.equal(calls.length, 0);

  const ran = await pruneActivityLog({ db, now: new Date('2026-09-23T07:03:00.000Z') });
  assert.deepEqual(ran, { deleted: 4, skipped: false });
  assert.match(calls[0].sql, /DELETE FROM activity_log/);
  assert.equal(calls[0].age, '-1 month');
});
