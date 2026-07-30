'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WeChatService } = require('../wechat/service');

function readyService(loadIpoCalendar = async () => ({ data: [] })) {
  const service = new WeChatService({ loadIpoCalendar, env: {} });
  service.ready = true;
  return service;
}

test('daily scheduler runs on a non-weekly day and only once per local date', async () => {
  const service = readyService();
  let weeklyRuns = 0;
  let dailyRuns = 0;
  service.runWeeklyPush = async () => { weeklyRuns += 1; };
  service.runDailyPush = async () => { dailyRuns += 1; };
  const thursdayAtNineShanghai = new Date('2026-07-30T01:00:00Z');

  await service.checkSchedule(thursdayAtNineShanghai);
  await service.checkSchedule(thursdayAtNineShanghai);

  assert.equal(weeklyRuns, 0);
  assert.equal(dailyRuns, 1);
  assert.equal(service.lastScheduledDay, '2026-07-30');
});

test('weekly and daily schedulers both run when their schedules are due', async () => {
  const service = readyService();
  const runs = [];
  service.runWeeklyPush = async () => { runs.push('weekly'); };
  service.runDailyPush = async () => { runs.push('daily'); };

  await service.checkSchedule(new Date('2026-07-27T01:00:00Z'));

  assert.deepEqual(runs, ['weekly', 'daily']);
});

test('daily push does not create a job when today has no IPO', async () => {
  const service = readyService(async () => ({
    data: [{ code: '001', applyDate: '2026-07-31' }],
  }));
  service.database.withAdvisoryLock = async () => {
    assert.fail('an empty daily push must not acquire a job lock');
  };

  const result = await service.runDailyPush({ now: new Date('2026-07-30T01:00:00Z') });

  assert.equal(result.accepted, false);
  assert.equal(result.date, '2026-07-30');
  assert.equal(result.ipoCount, 0);
});

test('daily push persists an idempotent job keyed by local date', async () => {
  const service = readyService(async () => ({
    data: [{ code: '001', name: '测试新股', applyCode: '730001', applyDate: '2026-07-30', price: 10 }],
  }));
  let lockName = '';
  let jobInput = null;
  service.database.withAdvisoryLock = async (name, callback) => {
    lockName = name;
    return { locked: true, result: await callback() };
  };
  service.database.createOrGetJob = async input => {
    jobInput = input;
    return { id: 42, status: 'completed' };
  };

  const result = await service.runDailyPush({ now: new Date('2026-07-30T01:00:00Z') });

  assert.equal(lockName, 'stock:wechat:daily-ipo');
  assert.equal(jobInput.jobKey, 'daily-ipo:2026-07-30');
  assert.equal(jobInput.weekStart, '2026-07-30');
  assert.equal(jobInput.weekEnd, '2026-07-30');
  assert.equal(jobInput.ipoCount, 1);
  assert.equal(result.alreadyCompleted, true);
  assert.equal(result.date, '2026-07-30');
});
