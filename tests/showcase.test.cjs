'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Script, runInNewContext } = require('node:vm')

function load() {
  let source = readFileSync(join(__dirname, '..', 'worker.js'), 'utf8')
  source = source.replace(/^\uFEFF?export default \{/, 'const worker = {')
    .replace("const ALLOWED_DOMAIN = 'your.domain.com'", "const ALLOWED_DOMAIN = 'test.example'")
  const context = { Response, URL, URLSearchParams }
  runInNewContext(source + '\nglobalThis.api = { handleRequest, renderGeneratorPage };', context)
  return context.api
}

const app = load()

test('public landing clearly explains self-hosting and no free hosting', () => {
  const html = app.renderGeneratorPage()
  assert.match(html, /This is a showcase, not a free badge-hosting service/)
  assert.match(html, /本站仅用于开源项目展示/)
  assert.match(html, /Deploy your own instance/)
  assert.match(html, /https:\/\/github.com\/FuTseYi\/Cloudflare-D1-Visit-Counter/)
  assert.match(html, /id="ownerDashboard"/)
  assert.match(html, /id="sampleBadge"/)
})

test('public landing browser script parses and preview renders locally', () => {
  const html = app.renderGeneratorPage()
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'embedded browser script is present')
  assert.doesNotThrow(() => new Script(match[1]))
  assert.match(match[1], /data:image\/svg\+xml;charset=utf-8/)
  assert.doesNotMatch(match[1], /\/api\/preview\?/)
})

test('public dashboard landing does not query D1 and API preview is not hosted', async () => {
  const forbiddenDB = new Proxy({}, { get: () => { throw new Error('Unexpected database access') } })
  const page = await app.handleRequest({ url: 'https://test.example/', method: 'GET' }, forbiddenDB)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Private management workspace/)
  const preview = await app.handleRequest({ url: 'https://test.example/api/preview?label=Someone', method: 'GET' }, forbiddenDB)
  assert.equal(preview.status, 404)
})
