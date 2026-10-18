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
    assert.equal((html.match(/id="authCode"/g)||[]).length, 1, 'Auth Code input must appear only once')
    assert.match(html, /id="counterSearch"/)
    assert.match(html, /id="sortCounters"/)
    assert.match(html, /id="lockDashboard"/)
    assert.match(html, /id="loadCounters"/)
    assert.match(html, /id="workspaceContent" hidden/)
    assert.match(html, /id="adminAside"[^>]* hidden/)
    assert.match(html, /id="adminLayout"/)
    assert.match(html, /id="authMessage"/)
    assert.equal((html.match(/data-workspace-section="[^"]+" disabled/g) || []).length, 4, 'locked sidebar navigation must be disabled')
    assert.equal((html.match(/class="embed-field"/g) || []).length, 5, 'embed outputs must be grouped into consistent fields')
    assert.match(html, /\.admin-workgrid\{display:grid;grid-template-columns:minmax\(0,1fr\)/)
    assert.match(html, /\.admin-main \.embed-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
    assert.match(html, /id="counterListPanel"/)
    assert.match(html, /id="editorPanel"/)
    assert.match(html, /id="embedPanel"/)
    assert.match(html, /id="counterCount"/)
    const js = scriptParses(html)
    assert.match(js, /fetch\('\/api\/list'/)
    assert.match(js, /'\/api\/rename'/)
    assert.match(js, /function setWorkspaceUnlocked\(unlocked\)/)
    assert.match(js, /function activateWorkspaceSection\(id, scroll = false\)/)
    assert.match(js, /counterSearch'\)\.addEventListener/)
    assert.match(js, /lockDashboard'\)\.addEventListener/)
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

test('sidebar is hidden while locked and highlights correct sections after unlock', () => {
  const html = app.renderGeneratorPage(request('/admin?lang=en'))
  const js = scriptParses(html)
  const begin = js.indexOf('    const sidebarButtons =')
  const end = js.indexOf('    function renderCounterList(counters)', begin)
  assert.ok(begin >= 0 && end > begin, 'navigation functions must be present')
  const source = js.slice(begin, end)
  const ids = ['overviewPanel','editorPanel','embedPanel','counterListPanel']
  const items = Object.create(null)
  const buttons = []
  function makeClasses() {
    const set = new Set()
    return {
      add(name) { set.add(name) },
      remove(name) { set.delete(name) },
      contains(name) { return set.has(name) },
      toggle(name, force) {
        if (force === undefined ? !set.has(name) : force) set.add(name)
        else set.delete(name)
      }
    }
  }
  function makeElement(id) {
    const attrs = Object.create(null)
    const element = {
      id, hidden: id !== 'authGate', disabled: true,
      classList: makeClasses(), dataset: {},
      attrs, listeners: {},
      setAttribute(name, value) { attrs[name] = value },
      removeAttribute(name) { delete attrs[name] },
      addEventListener(name, fn) { this.listeners[name] = fn },
      scrollIntoView() { this.didScroll = true },
      getBoundingClientRect() { return {top: this.position ?? 500} }
    }
    return element
  }
  for (const id of ['adminLayout','adminAside','workspaceContent','authGate','lockDashboard',...ids]) items[id] = makeElement(id)
  items.adminAside.hidden = true
  items.workspaceContent.hidden = true
  items.lockDashboard.hidden = true
  for (const id of ids) {
    const item = makeElement('nav-' + id)
    item.dataset.workspaceSection = id
    buttons.push(item)
  }
  const handlers = {}
  const doc = {
    querySelectorAll(selector) {
      assert.equal(selector, '[data-workspace-section]')
      return buttons
    },
    documentElement: { scrollHeight: 3000 }
  }
  const fakeWindow = {
    scrollY: 100, innerHeight: 900,
    matchMedia: () => ({matches: false}),
    addEventListener(name, fn) { handlers[name] = fn }
  }
  const nav = new Function('$', 'document', 'window', 'requestAnimationFrame',
    "let activeSection = '';"+source+
    'return {activateWorkspaceSection,setWorkspaceUnlocked,getActive:()=>activeSection}'
  )(id => items[id], doc, fakeWindow, fn => fn())
  assert.equal(items.adminAside.hidden, true)
  nav.activateWorkspaceSection('editorPanel', true)
  assert.equal(nav.getActive(), '', 'locked state must ignore navigation')
  nav.setWorkspaceUnlocked(true)
  assert.equal(items.adminAside.hidden, false)
  assert.equal(items.authGate.hidden, true)
  assert.equal(items.workspaceContent.hidden, false)
  assert.equal(items.adminLayout.classList.contains('is-unlocked'), true)
  assert.equal(buttons.every(b => !b.disabled), true)
  nav.activateWorkspaceSection('overviewPanel')
  assert.equal(buttons[0].attrs['aria-current'], 'location')
  buttons[2].listeners.click()
  assert.equal(nav.getActive(), 'embedPanel')
  assert.equal(buttons[2].attrs['aria-current'], 'location')
  assert.equal(buttons[0].attrs['aria-current'], undefined)
  assert.equal(items.embedPanel.didScroll, true)
  // Scroll-spy follows the visible pane instead of leaving the previous item active.
  items.overviewPanel.position = -600
  items.editorPanel.position = -150
  items.embedPanel.position = 80
  items.counterListPanel.position = 500
  handlers.scroll()
  assert.equal(nav.getActive(), 'embedPanel')
  items.counterListPanel.position = 85
  handlers.scroll()
  assert.equal(nav.getActive(), 'counterListPanel')
  nav.setWorkspaceUnlocked(false)
  assert.equal(items.adminAside.hidden, true)
  assert.equal(items.authGate.hidden, false)
  assert.equal(items.workspaceContent.hidden, true)
  assert.equal(buttons.every(b => b.disabled), true)
  assert.equal(buttons.every(b => !b.classList.contains('active')), true)
  assert.equal(buttons.every(b => !('aria-current' in b.attrs)), true)
  buttons[1].listeners.click()
  assert.equal(nav.getActive(), '', 'clicking while locked has no effect')
})
