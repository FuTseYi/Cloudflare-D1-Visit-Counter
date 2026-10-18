'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const { DatabaseSync } = require('node:sqlite')

// Run the actual, dependency-free Worker code with test-only credentials.
function loadWorker() {
  let source = readFileSync(join(__dirname, '..', 'worker.js'), 'utf8')
  source = source.replace(/^\uFEFF?export default \{/, 'const worker = {')
    .replace("const AUTH_CODE = 'change-this-auth-code'", "const AUTH_CODE = 'unit-test-secret'")
    .replace("const ALLOWED_DOMAIN = 'your.domain.com'", "const ALLOWED_DOMAIN = 'test.example'")
  const sandbox = { Response, URL, URLSearchParams }
  runInNewContext(source + '\nglobalThis.api = { handleCreateCounter, handleRenameCounter, handleDeleteCounter, handleVisitorBadge, handleStatusPage, handleMonthlyApi, getCounterAlias };', sandbox)
  return sandbox.api
}

const worker = loadWorker()

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:')
    this.sqlite.exec('CREATE TABLE counters (name TEXT PRIMARY KEY, count INTEGER DEFAULT 0)')
  }
  prepare(sql) {
    const sqliteStatement = this.sqlite.prepare(sql)
    const wrap = args => ({
      all: async () => ({ results: sqliteStatement.all(...args) }),
      run: async () => sqliteStatement.run(...args),
      bind: (...values) => wrap(values)
    })
    return wrap([])
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN')
    try {
      const results = []
      for (const stmt of statements) results.push(await stmt.run())
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }
  seed(key, count) {
    this.sqlite.prepare('INSERT INTO counters (name, count) VALUES (?, ?)').run(key, count)
  }
  value(key) {
    return this.sqlite.prepare('SELECT count FROM counters WHERE name = ?').get(key)?.count ?? null
  }
}

function manage(fn, db, body, authCode = 'unit-test-secret') {
  return fn({ method: 'POST', json: async () => ({ ...body, authCode }) }, db)
}

test('rename atomically preserves total, daily history and style', async () => {
  const db = new TestD1()
  db.seed('old:total', 42)
  db.seed('old:daily:2026-10-17', 5)
  db.seed('old:daily:2026-10-18', 7)
  db.seed('old:meta:label', 'Previous label')
  db.seed('old:meta:config', JSON.stringify({ label: 'Visitors', style: 'plastic' }))
  db.seed('old:meta:cleanup', '2026-10-18')
  const result = await manage(worker.handleRenameCounter, db, { counter: 'old', newCounter: 'new' })
  assert.equal(result.status, 200)
  assert.equal(db.value('new:total'), 42)
  assert.equal(db.value('old:total'), null)
  assert.equal(db.value('new:daily:2026-10-17'), 5)
  assert.equal(db.value('new:daily:2026-10-18'), 7)
  assert.equal(db.value('new:meta:label'), 'Previous label')
  assert.match(db.value('new:meta:config'), /plastic/)
  assert.equal(db.value('new:meta:cleanup'), '2026-10-18')
  assert.equal(db.value('old:meta:alias'), 'new')
})

test('old badge URL updates canonical counter, never creates its own total', async () => {
  const db = new TestD1()
  db.seed('old:total', 42)
  db.seed('old:daily:2026-10-18', 7)
  await manage(worker.handleRenameCounter, db, { counter: 'old', newCounter: 'new' })
  const response = await worker.handleVisitorBadge(new URL('https://test.example/api/combined?path=old'), db)
  assert.equal(response.status, 200)
  assert.equal(db.value('new:total'), 43)
  assert.equal(db.value('old:total'), null)
  const svg = await response.text()
  assert.match(svg, /Visitors/)
})

test('rename conflict cannot overwrite an existing counter', async () => {
  const db = new TestD1()
  db.seed('old:total', 10)
  db.seed('existing:total', 100)
  const response = await manage(worker.handleRenameCounter, db, { counter: 'old', newCounter: 'existing' })
  assert.equal(response.status, 409)
  assert.equal(db.value('old:total'), 10)
  assert.equal(db.value('existing:total'), 100)
})

test('cannot rename or create counters without owner authorization', async () => {
  const db = new TestD1()
  db.seed('old:total', 10)
  assert.equal((await manage(worker.handleRenameCounter, db, { counter: 'old', newCounter: 'new' }, 'wrong')).status, 403)
  assert.equal((await manage(worker.handleCreateCounter, db, { counter: 'guest-key' }, 'wrong')).status, 403)
  assert.equal(db.value('guest-key:total'), null)
})

test('aliases follow repeated renames and allow return to an owned key', async () => {
  const db = new TestD1()
  db.seed('first:total', 100)
  assert.equal((await manage(worker.handleRenameCounter, db, { counter: 'first', newCounter: 'second' })).status, 200)
  assert.equal((await manage(worker.handleRenameCounter, db, { counter: 'second', newCounter: 'third' })).status, 200)
  assert.equal(db.value('first:meta:alias'), 'third')
  assert.equal(db.value('second:meta:alias'), 'third')
  const reverted = await manage(worker.handleRenameCounter, db, { counter: 'third', newCounter: 'first' })
  assert.equal(reverted.status, 200)
  assert.equal(db.value('first:total'), 100)
  assert.equal(db.value('first:meta:alias'), null)
  assert.equal(db.value('second:meta:alias'), 'first')
  assert.equal(db.value('third:meta:alias'), 'first')
})

test('nested counter keys are not renamed or deleted by a parent operation', async () => {
  const db = new TestD1()
  db.seed('parent:total', 10)
  db.seed('parent:daily:2026-10-18:total', 88)
  db.seed('parent:daily:2026-10-18', 5)
  assert.equal((await manage(worker.handleRenameCounter, db, { counter: 'parent', newCounter: 'new-parent' })).status, 200)
  assert.equal(db.value('parent:daily:2026-10-18:total'), 88)
  assert.equal(db.value('new-parent:daily:2026-10-18'), 5)
  await manage(worker.handleDeleteCounter, db, { counter: 'new-parent' })
  assert.equal(db.value('parent:daily:2026-10-18:total'), 88)
  assert.equal(db.value('parent:meta:alias'), null)
})

test('renamed counter retains updated badge styling', async () => {
  const db = new TestD1()
  db.seed('old:total', 7)
  const response = await manage(worker.handleRenameCounter, db, {
    counter: 'old',
    newCounter: 'new',
    config: { label: 'Page views', labelColor: '#224466', countColor: '#112233', style: 'flat-square', labelStyle: 'none' }
  })
  assert.equal(response.status, 200)
  const config = JSON.parse(db.value('new:meta:config'))
  assert.equal(config.label, 'Page views')
  assert.equal(config.style, 'flat-square')
  assert.equal(config.labelStyle, 'none')
})

test('reserved alias cannot be repurposed for a different counter', async () => {
  const db = new TestD1()
  db.seed('old:total', 12)
  db.seed('other:total', 31)
  await manage(worker.handleRenameCounter, db, { counter: 'old', newCounter: 'new' })
  assert.equal((await manage(worker.handleCreateCounter, db, { counter: 'old' })).status, 409)
  assert.equal((await manage(worker.handleRenameCounter, db, { counter: 'other', newCounter: 'old' })).status, 409)
  assert.equal(db.value('new:total'), 12)
  assert.equal(db.value('other:total'), 31)
})

test('status pages work for existing keys and historical aliases without incrementing counts', async () => {
  const db = new TestD1()
  const oldKey = 'https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter'
  const newKey = 'https://github.com/FuTseYi/Visit-Counter'
  const today = new Date().toISOString().slice(0, 10)
  db.seed(oldKey + ':total', 123)
  db.seed(oldKey + ':daily:' + today, 8)
  const statusUrl = key => new URL('https://test.example/status?path=' + encodeURIComponent(key))
  const before = await worker.handleStatusPage(statusUrl(oldKey), db)
  assert.equal(before.status, 200)
  assert.match(await before.text(), /123/)
  const renamed = await manage(worker.handleRenameCounter, db, { counter: oldKey, newCounter: newKey })
  assert.equal(renamed.status, 200)
  for (const key of [oldKey, newKey]) {
    const response = await worker.handleStatusPage(statusUrl(key), db)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /123/)
    assert.match(html, /Visitor trend/)
    assert.match(html, /Visit-Counter/)
  }
  assert.equal(db.value(newKey + ':total'), 123)
  assert.equal(db.value(oldKey + ':total'), null)
})

test('monthly JSON works for direct keys and aliases without modifying statistics', async () => {
  const db = new TestD1()
  db.seed('old:total', 67)
  db.seed('old:daily:' + new Date().toISOString().slice(0, 10), 3)
  const monthlyUrl = key => new URL('https://test.example/api/monthly?path=' + encodeURIComponent(key))
  const direct = await worker.handleMonthlyApi(monthlyUrl('old'), db)
  assert.equal(direct.status, 200)
  assert.equal((await direct.json()).total, 67)
  await manage(worker.handleRenameCounter, db, { counter: 'old', newCounter: 'new' })
  for (const key of ['old', 'new']) {
    const response = await worker.handleMonthlyApi(monthlyUrl(key), db)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.counter, 'new')
    assert.equal(data.total, 67)
    assert.equal(data.daily, 3)
  }
  assert.equal(db.value('new:total'), 67)
})
