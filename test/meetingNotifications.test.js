const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Teams retries failures independently of SMTP and records success', async (t) => {
  const dbPath = require.resolve('../src/db');
  const servicePath = require.resolve('../src/services/notificationService');
  const workerPath = require.resolve('../src/services/meetingMail');
  const saved = [dbPath, servicePath, workerPath].map((p) => require.cache[p]);
  const env = { ...process.env };
  t.after(() => {
    [dbPath, servicePath, workerPath].forEach((p, i) => {
      if (saved[i]) require.cache[p] = saved[i];
      else delete require.cache[p];
    });
    process.env = env;
  });
  process.env.TEAMS_WEBHOOK_URL = 'https://example.test/webhook';
  delete process.env.SMTP_HOST;
  const updates = [];
  let ok = false;
  require.cache[dbPath] = { exports: {
    withTransaction: (fn) => fn({ query: async (sql, params) => {
      if (sql.startsWith('SELECT')) return { rows: [{ id: 1, subject: 'Đã duyệt', body: 'Meeting' }] };
      updates.push({ sql, params });
      return { rows: [] };
    } }),
  } };
  require.cache[servicePath] = { exports: {
    sendTeamsMessage: async () => ok ? { ok: true } : { ok: false, status: 503, body: 'Unavailable' },
  } };
  delete require.cache[workerPath];
  const { flush } = require(workerPath);
  await flush();
  assert.match(updates[0].sql, /attempts=attempts\+1,last_error=\$2/);
  assert.equal(updates[0].params[1], 'Unavailable');
  ok = true;
  await flush();
  assert.match(updates[1].sql, /sent_at=NOW\(\)/);
});
