'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Script, runInNewContext } = require('node:vm')

function load() {
  const source = readFileSync(join(__dirname, '..', 'worker.js'), 'utf8')
    .replace(/^\uFEFF?export default \{/, 'const worker = {')
    .replace("const ALLOWED_DOMAIN = 'your.domain.com'", "const ALLOWED_DOMAIN = 'test.example'")
  const context = { Response, URL, URLSearchParams }
  runInNewContext(source + '\nglobalThis.api = { handleRequest, renderLandingPage, renderGeneratorPage, renderStatusPage, renderDashboardChart };', context)
  return context.api
}
const app = load()
const request = (path, acceptLanguage = '') => ({
  url: 'https://test.example' + path,
  method: 'GET',
  headers: { get: name => name.toLowerCase() === 'accept-language' ? acceptLanguage : '' }
})
const unavailableDB = new Proxy({}, { get: () => { throw Error('Unexpected D1 access from public UI') } })
function scriptParses(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  assert.ok(match, 'expected inline script')
  assert.doesNotThrow(() => new Script(match[1]))
  return match[1]
}

test('public bilingual landing keeps self-hosted usage clear', async () => {
  for (const lang of ['zh', 'en']) {
    const response = await app.handleRequest(request('/?lang=' + lang), unavailableDB)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /id="sampleBadge"/)
    assert.match(html, /data-demo-theme="blue"/)
    assert.match(html, /href="\/admin\?lang=/)
    assert.match(html, /github.com\/FuTseYi\/Cloudflare-D1-Visit-Counter/)
    assert.match(html, /aria-current="page"/)
    assert.doesNotMatch(html, /id="authCode"/, 'login form must not appear on public homepage')
    scriptParses(html)
    if (lang === 'zh') {
      assert.match(html, /不提供免费的徽章生成或后台托管服务/)
      assert.match(html, /部署自己的实例/)
    } else {
      assert.match(html, /not a free badge-hosting service/)
      assert.match(html, /Deploy your own instance/)
    }
  }
})

test('Accept-Language defaults to Chinese for Chinese-speaking visitors', () => {
  const html = app.renderLandingPage(request('/', 'zh-CN,zh;q=0.9,en;q=0.7'))
  assert.match(html, /<html lang="zh-CN">/)
  assert.match(html, /三步/)
  assert.match(html, /href="\/\?lang=en"/)
})

test('owner dashboard is an independent route and hides workspace until authorized', async () => {
  for (const lang of ['en', 'zh']) {
    const response = await app.handleRequest(request('/admin?lang=' + lang), unavailableDB)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /id="authGate"/)
    assert.match(html, /id="authCode"/)
    assert.match(html, /id="loadCounters"/)
    assert.match(html, /id="workspaceContent" hidden/)
    assert.match(html, /id="counterListPanel"/)
    assert.match(html, /id="editorPanel"/)
    assert.match(html, /id="embedPanel"/)
    assert.match(html, /id="counterCount"/)
    const js = scriptParses(html)
    assert.match(js, /fetch\('\/api\/list'/)
    assert.match(js, /'\/api\/rename'/)
    assert.match(js, /workspaceContent'\)\.hidden = false/)
    assert.match(js, /data:image\/svg\+xml;charset=utf-8/)
    if (lang === 'zh') assert.match(html, /解锁管理工作区/)
    else assert.match(html, /Unlock your workspace/)
  }
})

test('public analytics are bilingual, responsive and include real series', () => {
  const series = [
    {date:'2026-10-16',count:2},
    {date:'2026-10-17',count:5},
    {date:'2026-10-18',count:11}
  ]
  for (const lang of ['en','zh']) {
    const html = app.renderStatusPage({counter:'https://github.com/example/repo',total:154,daily:11,series,lang})
    assert.match(html, /154/)
    assert.match(html, /id="chart7"/)
    assert.match(html, /id="chartAll"/)
    assert.match(html, /data-range="7"/)
    assert.match(html, /role="img"/)
    assert.match(html, /2026-10-18: 11/)
    assert.match(html, /&amp;lang=/, 'language links must preserve counter query')
    scriptParses(html)
    if (lang === 'zh') assert.match(html, /访问统计概览/)
    else assert.match(html, /Analytics overview/)
  }
})

test('analytics error page is localized and does not leak any counter state', () => {
  const html = app.renderStatusPage({counter:'missing',error:'Counter not found',lang:'zh'})
  assert.match(html, /无法加载计数器/)
  assert.doesNotMatch(html, /id="chart7"/)
  assert.match(html, /返回首页/)
})

test('unsupported unauthenticated badge preview remains blocked', async () => {
  const response = await app.handleRequest(request('/api/preview?label=Visitors'),unavailableDB)
  assert.equal(response.status,404)
})
