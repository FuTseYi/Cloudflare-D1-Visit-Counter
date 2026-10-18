export default {
  async fetch(request, env) {
    return handleRequest(request, env.HITS)
  }
}

const ALLOWED_DOMAIN = 'your.domain.com'
const AUTH_CODE = 'change-this-auth-code'
const ALLOWED_PATHS = []
const HISTORY_DAYS = 30
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M14 46H50" fill="none" stroke="#24292F" stroke-width="4" stroke-linecap="round"/><path d="M16 40L28 31L37 34L50 19" fill="none" stroke="#24292F" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><text x="50" y="58" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="2.2" font-weight="600" fill="#24292F" opacity=".16">FuTseYi</text></svg>'
const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
const PROJECT_LOGO_SVG = FAVICON_SVG.replace('<svg ', '<svg class="project-logo" aria-hidden="true" ')
const namedColors = {
  brightgreen: '#4c1',
  green: '#97ca00',
  yellow: '#dfb317',
  yellowgreen: '#a4a61d',
  orange: '#fe7d37',
  red: '#e05d44',
  blue: '#007ec6',
  grey: '#555',
  lightgrey: '#9f9f9f',
  gray: '#555',
  lightgray: '#9f9f9f',
  critical: '#e05d44',
  important: '#fe7d37',
  success: '#4c1',
  informational: '#007ec6',
  inactive: '#9f9f9f',
}

async function handleRequest(request, db) {
  const url = new URL(request.url)

  if (url.hostname !== ALLOWED_DOMAIN) {
    return textResponse('Not Found', 404)
  }

  if (url.pathname === '/' || url.pathname === '') return htmlResponse(renderLandingPage(request))
  if (url.pathname === '/admin' || url.pathname === '/admin/') return htmlResponse(renderGeneratorPage(request))

  if (url.pathname === '/api/create') {
    return handleCreateCounter(request, db)
  }

  if (url.pathname === '/api/rename') {
    return handleRenameCounter(request, db)
  }

  if (url.pathname === '/api/list') {
    return handleListCounters(request, db)
  }

  if (url.pathname === '/api/delete') {
    return handleDeleteCounter(request, db)
  }

  // Browser previews are generated locally; never offer public SVG generation.
  if (url.pathname === '/api/preview') return textResponse('Not Found', 404)

  if (url.pathname === '/api/combined') {
    return handleVisitorBadge(url, db)
  }

  if (url.pathname === '/status') {
    return handleStatusPage(url, db, request)
  }

  if (url.pathname === '/api/monthly') {
    return handleMonthlyApi(url, db)
  }

  if (url.pathname === '/history.svg' || url.pathname === '/chart.svg') {
    return handleHistoryChart(url, db, url.searchParams.get('counter') || url.searchParams.get('path'))
  }

  if (url.pathname === '/example.svg') {
    return svgResponse(generateBadgeSvg({
      title: getParam(url, 'label', 'title') || 'Hits',
      titleBg: getParam(url, 'labelColor', 'title_bg') || 'grey',
      countBg: getParam(url, 'countColor', 'count_bg') || 'green',
      edgeFlat: url.searchParams.get('edge_flat') === 'true',
      style: url.searchParams.get('style') || 'flat',
      labelStyle: url.searchParams.get('labelStyle') || 'default',
      dailyCount: 123,
      totalCount: 456,
    }))
  }

  const historyMatch = url.pathname.match(/^\/(?:history|chart)\/([a-zA-Z0-9_-]+)\.svg$/)
  if (historyMatch) {
    return handleHistoryChart(url, db, historyMatch[1])
  }

  const badgeMatch = url.pathname.match(/^\/(.+?)(?:\.svg)?$/)
  if (badgeMatch) {
    return handleCounterRequest(url, db, decodeURIComponent(badgeMatch[1]), url.pathname.endsWith('.svg'))
  }

  return textResponse('Not Found', 404)
}

async function handleCreateCounter(request, db) {
  if (request.method !== 'POST') {
    return textResponse('Method not allowed', 405)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const counter = normalizeCounterName(body.counter)
  const badgeConfig = normalizeBadgeConfig(body)
  if (!counter) {
    return jsonResponse({ error: 'Counter key must be 1-512 characters and cannot include control characters' }, 400)
  }

  const authError = validateAuthCode(body.authCode)
  if (authError) return authError
  if (!isCounterAllowed(counter)) {
    return jsonResponse({ error: 'Counter is not in ALLOWED_PATHS' }, 403)
  }

  const exists = await counterExists(db, counter)
  if (!exists && await getCounterAlias(db, counter)) {
    return jsonResponse({ error: 'This key is reserved by an earlier rename. Edit its active counter instead.' }, 409)
  }
  if (exists) {
    await setCounterConfig(db, counter, badgeConfig)
    const today = todayString()
    const total = await getCounter(db, `${counter}:total`)
    const daily = await getCounter(db, `${counter}:daily:${today}`)
    return jsonResponse({
      warning: 'Counter already exists',
      exists: true,
      counter,
      daily,
      total,
      badge: `https://${ALLOWED_DOMAIN}/${counter}.svg?action=hit`,
      history: `https://${ALLOWED_DOMAIN}/history/${counter}.svg`,
    })
  }

  await createCounter(db, counter)
  await setCounterConfig(db, counter, badgeConfig)
  return jsonResponse({
    success: true,
    counter,
    daily: 0,
    total: 0,
    badge: `https://${ALLOWED_DOMAIN}/${counter}.svg?action=hit`,
    history: `https://${ALLOWED_DOMAIN}/history/${counter}.svg`,
  }, 201)
}

// Rename counters without resetting their totals, trends or badge styles.
// D1 batch() is atomic: a uniqueness collision rolls back every statement.
async function handleRenameCounter(request, db) {
  if (request.method !== 'POST') return textResponse('Method not allowed', 405)
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  const authError = validateAuthCode(body.authCode)
  if (authError) return authError
  const previous = normalizeCounterName(body.counter)
  const next = normalizeCounterName(body.newCounter)
  if (!previous || !next) return jsonResponse({ error: 'Both counter keys must be 1-512 valid characters.' }, 400)
  if (previous === next) return jsonResponse({ error: 'The new URL must differ from the current URL.' }, 400)
  if (!isCounterAllowed(previous) || !isCounterAllowed(next)) {
    return jsonResponse({ error: 'Both keys must be included in ALLOWED_PATHS.' }, 403)
  }
  if (!await counterExists(db, previous)) return jsonResponse({ error: 'Original counter not found.' }, 404)
  // Moving back to your own previous URL is safe: release that alias inside
  // the same transaction, then promote the key to the canonical counter.
  const existingAlias = await getCounterAlias(db, next)
  if (await counterExists(db, next) || (existingAlias && existingAlias !== previous)) {
    return jsonResponse({ error: 'Target key already exists or belongs to another counter.' }, 409)
  }

  // The existing D1 table stores each counter as a family of suffixed keys.
  // Include only its own well-known metadata and daily YYYY-MM-DD keys,
  // so other counters with overlapping prefixes are never touched.
  const suffixes = [':total', ':meta:config', ':meta:label', ':meta:cleanup']
  const oldKeys = suffixes.map(suffix => previous + suffix)
  const oldDaily = previous + ':daily:'
  const newDaily = next + ':daily:'
  const move = db.prepare(`
    UPDATE counters SET name = CASE
      WHEN name = ? THEN ?
      WHEN name = ? THEN ?
      WHEN name = ? THEN ?
      WHEN name = ? THEN ?
      ELSE ? || substr(name, ?)
    END
    WHERE name IN (?, ?, ?, ?)
       OR (substr(name, 1, ?) = ? AND length(name) = ?
           AND substr(name, ?) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
  `).bind(
    previous + ':total', next + ':total',
    previous + ':meta:config', next + ':meta:config',
    previous + ':meta:label', next + ':meta:label',
    previous + ':meta:cleanup', next + ':meta:cleanup',
    newDaily, oldDaily.length + 1,
    ...oldKeys,
    oldDaily.length, oldDaily, oldDaily.length + 10, oldDaily.length + 1
  )
  const repoint = db.prepare("UPDATE counters SET count = ? WHERE name GLOB '*:meta:alias' AND count = ?")
    .bind(next, previous)
  const alias = db.prepare('INSERT INTO counters (name, count) VALUES (?, ?)')
    .bind(previous + ':meta:alias', next)
  const operations = [
    ...(existingAlias === previous ? [db.prepare('DELETE FROM counters WHERE name = ?').bind(next + ':meta:alias')] : []),
    move, repoint, alias
  ]
  if (body.config !== undefined) {
    operations.push(db.prepare(`
      INSERT INTO counters (name, count) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET count = excluded.count
    `).bind(next + ':meta:config', JSON.stringify(normalizeBadgeConfig(body.config))))
  }

  try {
    await db.batch(operations)
  } catch {
    return jsonResponse({ error: 'Rename could not be completed. The target may have conflicting data; no changes were saved.' }, 409)
  }
  const today = todayString()
  return jsonResponse({
    success: true, counter: next, previous,
    total: await getCounter(db, next + ':total'),
    daily: await getCounter(db, next + ':daily:' + today),
    legacyLinks: 'Existing badge and status URLs using the old counter key remain compatible.'
  })
}

async function getCounterAlias(db, counter) {
  // Aliases store TEXT in the legacy SQLite count column; getCounterValue
  // intentionally coerces numeric counters and must not be used here.
  const { results } = await db.prepare('SELECT count FROM counters WHERE name = ? LIMIT 1')
    .bind(counter + ':meta:alias').all()
  if (!results.length || typeof results[0].count !== 'string') return null
  const target = normalizeCounterName(results[0].count)
  return target && target !== counter && isCounterAllowed(target) ? target : null
}

async function resolveCounterForRead(db, counter) {
  if (await counterExists(db, counter)) return counter
  const target = await getCounterAlias(db, counter)
  return target && await counterExists(db, target) ? target : null
}

async function handleListCounters(request, db) {
  if (request.method !== 'POST') {
    return textResponse('Method not allowed', 405)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const authError = validateAuthCode(body.authCode)
  if (authError) return authError

  const { results } = await db.prepare(`
    SELECT name, count
    FROM counters
    WHERE name LIKE '%:total'
    ORDER BY name ASC
  `).all()

  const counters = []
  for (const row of results) {
    const counter = String(row.name).slice(0, -6)
    counters.push({
      counter,
      config: await getCounterConfig(db, counter),
      daily: await getCounter(db, `${counter}:daily:${todayString()}`),
      total: Number(row.count) || 0,
    })
  }

  return jsonResponse({ counters })
}

async function handleDeleteCounter(request, db) {
  if (request.method !== 'POST') {
    return textResponse('Method not allowed', 405)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const authError = validateAuthCode(body.authCode)
  if (authError) return authError

  const counter = normalizeCounterName(body.counter)
  if (!counter) {
    return jsonResponse({ error: 'Counter key must be 1-512 characters and cannot include control characters' }, 400)
  }

  const dailyPrefix = `${counter}:daily:`
  await db.batch([
    db.prepare("DELETE FROM counters WHERE name IN (?, ?, ?, ?) OR (substr(name, 1, ?) = ? AND length(name) = ? AND substr(name, ?) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')")
      .bind(`${counter}:total`, `${counter}:meta:label`, `${counter}:meta:config`, `${counter}:meta:cleanup`, dailyPrefix.length, dailyPrefix, dailyPrefix.length + 10, dailyPrefix.length + 1),
    db.prepare("DELETE FROM counters WHERE name GLOB '*:meta:alias' AND count = ?").bind(counter),
  ])

  return jsonResponse({ success: true, counter })
}

function validateAuthCode(authCode) {
  const configuredAuthCode = String(AUTH_CODE || '').trim()
  const submittedAuthCode = String(authCode || '').trim()
  if (!configuredAuthCode || configuredAuthCode === 'change-this-auth-code') {
    return jsonResponse({ error: 'Auth code is not configured. Set AUTH_CODE in worker.js before deployment.' }, 500)
  }
  if (!submittedAuthCode) {
    return jsonResponse({ error: 'Auth code is required' }, 400)
  }
  if (submittedAuthCode !== configuredAuthCode) {
    return jsonResponse({ error: 'Invalid auth code' }, 403)
  }
  return null
}

async function handleCounterRequest(url, db, counter, isSvg) {
  counter = normalizeCounterName(counter)
  if (!counter || !isCounterAllowed(counter)) {
    return textResponse('Not Found', 404)
  }

  const action = (url.searchParams.get('action') || 'view').toLowerCase()
  if (!['view', 'hit'].includes(action)) {
    return jsonResponse({ error: 'Invalid action. Use view or hit.' }, 400)
  }

  const today = todayString()
  let total
  let daily
  if (action === 'hit') {
    total = await incrementExistingCounter(db, `${counter}:total`)
    if (total === null) {
      const canonical = await getCounterAlias(db, counter)
      if (!canonical) return textResponse('Counter not found', 404)
      counter = canonical
      total = await incrementExistingCounter(db, `${counter}:total`)
      if (total === null) return textResponse('Counter not found', 404)
    }
    daily = await incrementCounter(db, `${counter}:daily:${today}`)
    if (daily === 1) await cleanupOldDailyData(db, counter, today)
  } else {
    total = await getCounterValue(db, `${counter}:total`)
    if (total === null) {
      const canonical = await getCounterAlias(db, counter)
      if (!canonical) return textResponse('Counter not found', 404)
      counter = canonical
      total = await getCounterValue(db, `${counter}:total`)
      if (total === null) return textResponse('Counter not found', 404)
    }
    daily = await getCounter(db, `${counter}:daily:${today}`)
  }

  if (isSvg) {
    const badgeConfig = await resolveBadgeConfig(db, counter, url)
    return svgResponse(generateBadgeSvg({
      title: badgeConfig.label || 'Hits',
      titleBg: badgeConfig.labelColor,
      countBg: badgeConfig.countColor,
      edgeFlat: url.searchParams.get('edge_flat') === 'true',
      style: badgeConfig.style,
      labelStyle: badgeConfig.labelStyle,
      dailyCount: daily,
      totalCount: total,
    }))
  }

  return jsonResponse({
    counter,
    action,
    total,
    daily,
    date: today,
    timestamp: new Date().toISOString(),
  })
}

async function handleVisitorBadge(url, db) {
  let counter = normalizeCounterName(url.searchParams.get('counter') || url.searchParams.get('path'))
  if (!counter) {
    return jsonResponse({ error: 'Missing or invalid path' }, 400)
  }

  if (!isCounterAllowed(counter)) {
    return textResponse('Not Found', 404)
  }

  const today = todayString()
  let total = await incrementExistingCounter(db, `${counter}:total`)
  if (total === null) {
    const canonical = await getCounterAlias(db, counter)
    if (!canonical) return textResponse('Counter not found', 404)
    counter = canonical
    total = await incrementExistingCounter(db, `${counter}:total`)
    if (total === null) return textResponse('Counter not found', 404)
  }
  const daily = await incrementCounter(db, `${counter}:daily:${today}`)
  if (daily === 1) await cleanupOldDailyData(db, counter, today)
  const badgeConfig = await resolveBadgeConfig(db, counter, url)

  return svgResponse(generateBadgeSvg({
    title: badgeConfig.label || 'Visitors',
    titleBg: badgeConfig.labelColor,
    countBg: badgeConfig.countColor,
    edgeFlat: url.searchParams.get('edge_flat') === 'true',
    style: badgeConfig.style,
    labelStyle: badgeConfig.labelStyle,
    dailyCount: daily,
    totalCount: total,
  }))
}

async function handleStatusPage(url, db, request = { url: url.toString() }) {
  const lang = uiLang(request)
  let counter = normalizeCounterName(url.searchParams.get('counter') || url.searchParams.get('path'))
  if (!counter) {
    return htmlResponse(renderStatusPage({ error: 'Missing or invalid path', lang }))
  }

  const canonical = await resolveCounterForRead(db, counter)
  if (!canonical) return htmlResponse(renderStatusPage({ counter, error: 'Counter not found', lang }))
  counter = canonical
  const today = todayString()
  const total = await getCounterValue(db, `${counter}:total`)
  const daily = await getCounter(db, `${counter}:daily:${today}`)
  const historyDays = getHistoryDays()
  const days = clampInt(url.searchParams.get('days'), historyDays, 1, historyDays)
  const series = await getDailySeries(db, counter, days)
  return htmlResponse(renderStatusPage({ counter, total, daily, series, lang }))
}
async function handleHistoryChart(url, db, counter) {
  counter = normalizeCounterName(counter)
  if (!counter) {
    return textResponse('Missing or invalid path', 400)
  }

  if (!isCounterAllowed(counter)) {
    return textResponse('Not Found', 404)
  }

  const canonical = await resolveCounterForRead(db, counter)
  if (!canonical) return textResponse('Counter not found', 404)
  counter = canonical

  const historyDays = getHistoryDays()
  const days = clampInt(url.searchParams.get('days'), historyDays, 1, historyDays)
  const width = clampInt(url.searchParams.get('width'), 900, 320, 2400)
  const height = clampInt(url.searchParams.get('height'), 520, 220, 1400)
  const chartType = (url.searchParams.get('chartType') || 'bar').toLowerCase()
  const safeChartType = ['bar', 'line', 'area', 'scatter'].includes(chartType) ? chartType : 'bar'
  const color = resolveColor(url.searchParams.get('color') || url.searchParams.get('count_bg') || 'green')
  const title = url.searchParams.get('title') || `${counter} daily hits`
  const series = await getDailySeries(db, counter, days)

  return svgResponse(generateHistorySvg({
    title,
    series,
    width,
    height,
    chartType: safeChartType,
    color,
  }), 'public, max-age=300')
}

async function handleMonthlyApi(url, db) {
  let counter = normalizeCounterName(url.searchParams.get('counter') || url.searchParams.get('path'))
  if (!counter) {
    return jsonResponse({ error: 'Missing or invalid path' }, 400)
  }
  if (!isCounterAllowed(counter)) {
    return textResponse('Not Found', 404)
  }

  const canonical = await resolveCounterForRead(db, counter)
  if (!canonical) return textResponse('Counter not found', 404)
  counter = canonical
  const today = todayString()
  const total = await getCounterValue(db, `${counter}:total`)

  const month = today.slice(0, 7)
  const monthStart = `${month}-01`
  const dailyPrefix = `${counter}:daily:`
  const { results } = await db.prepare(`
    SELECT name, count
    FROM counters
    WHERE substr(name, 1, ?) = ?
      AND substr(name, ?) BETWEEN ? AND ?
    ORDER BY name ASC
  `).bind(dailyPrefix.length, dailyPrefix, dailyPrefix.length + 1, monthStart, today).all()
  const days = results.map(row => ({
    date: String(row.name).slice(dailyPrefix.length),
    count: Number(row.count) || 0,
  }))
  const monthly = days.reduce((sum, item) => sum + item.count, 0)

  return jsonResponse({
    counter,
    month,
    total,
    monthly,
    daily: await getCounter(db, `${counter}:daily:${today}`),
    days,
  })
}

async function counterExists(db, counter) {
  const { results } = await db.prepare('SELECT 1 FROM counters WHERE name = ? LIMIT 1')
    .bind(`${counter}:total`)
    .all()
  return results.length > 0
}

async function createCounter(db, counter) {
  await db.prepare('INSERT INTO counters (name, count) VALUES (?, 0)')
    .bind(`${counter}:total`)
    .run()
}

async function setCounterConfig(db, counter, config) {
  await db.prepare(`
    INSERT INTO counters (name, count)
    VALUES (?, ?)
    ON CONFLICT(name)
    DO UPDATE SET count = excluded.count
  `).bind(`${counter}:meta:config`, JSON.stringify(config)).run()
}

async function getCounterConfig(db, counter) {
  const { results } = await db.prepare('SELECT count FROM counters WHERE name = ?')
    .bind(`${counter}:meta:config`)
    .all()
  if (!results.length) {
    const legacy = await getLegacyCounterLabel(db, counter)
    return normalizeBadgeConfig({ label: legacy })
  }
  try {
    return normalizeBadgeConfig(JSON.parse(String(results[0].count || '{}')))
  } catch {
    return normalizeBadgeConfig({})
  }
}

async function resolveBadgeConfig(db, counter, url) {
  const urlConfig = {
    label: getParam(url, 'label', 'title'),
    labelColor: getParam(url, 'labelColor', 'title_bg'),
    countColor: getParam(url, 'countColor', 'count_bg'),
    style: url.searchParams.get('style') || '',
    labelStyle: url.searchParams.get('labelStyle') || '',
  }
  if (urlConfig.label && urlConfig.labelColor && urlConfig.countColor && urlConfig.style && urlConfig.labelStyle) {
    return normalizeBadgeConfig(urlConfig)
  }

  const saved = await getCounterConfig(db, counter)
  return normalizeBadgeConfig({
    label: urlConfig.label || saved.label,
    labelColor: urlConfig.labelColor || saved.labelColor,
    countColor: urlConfig.countColor || saved.countColor,
    style: urlConfig.style || saved.style,
    labelStyle: urlConfig.labelStyle || saved.labelStyle,
  })
}

async function getLegacyCounterLabel(db, counter) {
  const { results } = await db.prepare('SELECT count FROM counters WHERE name = ?')
    .bind(`${counter}:meta:label`)
    .all()
  return results.length ? String(results[0].count || '') : ''
}
async function getCounterValue(db, key) {
  const { results } = await db.prepare('SELECT count FROM counters WHERE name = ?')
    .bind(key)
    .all()
  return results.length ? Number(results[0].count) : null
}

async function getCounter(db, key) {
  return await getCounterValue(db, key) ?? 0
}

async function incrementExistingCounter(db, key) {
  const { results } = await db.prepare('UPDATE counters SET count = count + 1 WHERE name = ? RETURNING count')
    .bind(key)
    .all()
  return results.length ? Number(results[0].count) : null
}

async function incrementCounter(db, key) {
  const { results } = await db.prepare(`
    INSERT INTO counters (name, count)
    VALUES (?, 1)
    ON CONFLICT(name)
    DO UPDATE SET count = count + 1
    RETURNING count
  `).bind(key).all()
  return Number(results[0].count)
}

async function cleanupOldDailyData(db, counter, today) {
  const todayNumber = Number(today.replace(/-/g, ''))
  const historyDays = getHistoryDays()
  const cleanupMarker = todayNumber * 10000 + historyDays
  const cleanupKey = `${counter}:meta:cleanup`
  const lastCleanup = await getCounter(db, cleanupKey)
  if (lastCleanup === cleanupMarker) return

  const cutoff = offsetDateString(-historyDays + 1)
  const dailyPrefix = `${counter}:daily:`
  await db.prepare(`
    DELETE FROM counters
    WHERE substr(name, 1, ?) = ?
      AND substr(name, ?) < ?
  `).bind(dailyPrefix.length, dailyPrefix, dailyPrefix.length + 1, cutoff).run()

  await db.prepare(`
    INSERT INTO counters (name, count)
    VALUES (?, ?)
    ON CONFLICT(name)
    DO UPDATE SET count = excluded.count
  `).bind(cleanupKey, cleanupMarker).run()
}
async function getDailySeries(db, counter, days) {
  const today = todayString()
  const cutoff = offsetDateString(-days + 1)
  const prefix = `${counter}:daily:`
  const { results } = await db.prepare(`
    SELECT name, count
    FROM counters
    WHERE substr(name, 1, ?) = ?
      AND substr(name, ?) BETWEEN ? AND ?
    ORDER BY name ASC
  `).bind(prefix.length, prefix, prefix.length + 1, cutoff, today).all()

  if (!results.length) {
    return [{ date: today, count: 0 }]
  }

  const countByDate = new Map()
  for (const row of results) {
    countByDate.set(String(row.name).slice(prefix.length), Number(row.count) || 0)
  }

  const firstDate = String(results[0].name).slice(prefix.length)
  return dateRange(firstDate, today).map(date => ({
    date,
    count: countByDate.get(date) || 0,
  }))
}

function generateBadgeSvg({ title, titleBg, countBg, edgeFlat, style, labelStyle, dailyCount, totalCount }) {
  const badgeStyle = normalizeBadgeStyle(style, edgeFlat)
  const rawTitle = String(title || 'Hits').slice(0, 48)
  const titleText = badgeStyle === 'for-the-badge' ? rawTitle.toUpperCase() : rawTitle
  const safeTitle = escapeXml(titleText)
  const countText = normalizeLabelStyle(labelStyle) === 'none' ? `${totalCount}` : `${dailyCount} / ${totalCount}`
  const height = badgeStyle === 'for-the-badge' ? 28 : 20
  const fontSize = badgeStyle === 'for-the-badge' ? 12 : 11
  const baseline = badgeStyle === 'for-the-badge' ? 18 : 14
  const titleWidth = getTextWidth(titleText) + (badgeStyle === 'for-the-badge' ? 14 : 0)
  const countWidth = getTextWidth(countText) + (badgeStyle === 'for-the-badge' ? 14 : 0)
  const width = titleWidth + countWidth
  const radius = badgeStyle === 'flat-square' || badgeStyle === 'for-the-badge' ? 0 : 3
  const titleColor = badgeStyle === 'social' ? '#fff' : resolveColor(titleBg)
  const countColor = resolveColor(countBg)
  const border = badgeStyle === 'social' ? `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius}" fill="none" stroke="#d0d7de"/>` : ''
  const titleTextColor = badgeStyle === 'social' ? '#24292f' : getReadableTextColor(titleColor)
  const countTextColor = getReadableTextColor(countColor)
  const gradientOpacity = badgeStyle === 'plastic' ? '.22' : '.10'

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${safeTitle}: ${countText}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity="${gradientOpacity}"/>
    <stop offset="1" stop-color="#000" stop-opacity="${gradientOpacity}"/>
  </linearGradient>
  <clipPath id="r"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${titleWidth}" height="${height}" fill="${titleColor}"/>
    <rect x="${titleWidth}" width="${countWidth}" height="${height}" fill="${countColor}"/>
    <rect width="${width}" height="${height}" fill="url(#s)"/>
  </g>
  ${border}
  <g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="${fontSize}" font-weight="${badgeStyle === 'for-the-badge' ? '700' : '400'}">
    <text x="${Math.floor(titleWidth / 2)}" y="${baseline}" fill="${titleTextColor}">${safeTitle}</text>
    <text x="${titleWidth + Math.floor(countWidth / 2)}" y="${baseline}" fill="${countTextColor}">${countText}</text>
  </g>
</svg>`
}

function normalizeLabelStyle(labelStyle) {
  const value = String(labelStyle || 'default').toLowerCase()
  return ['default', 'none'].includes(value) ? value : 'default'
}

function normalizeBadgeStyle(style, edgeFlat) {
  if (edgeFlat) return 'flat-square'
  const value = String(style || 'flat').toLowerCase()
  return ['flat', 'flat-square', 'plastic', 'for-the-badge', 'social'].includes(value) ? value : 'flat'
}

function getReadableTextColor(color) {
  let hex = resolveColor(color).replace('#', '')
  if (hex.length === 3) {
    hex = hex.split('').map(char => char + char).join('')
  }
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#24292f' : '#fff'
}
function generateHistorySvg({ title, series, width, height, chartType, color }) {
  const padding = { top: 58, right: 34, bottom: 58, left: 58 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const maxCount = Math.max(...series.map(item => item.count), 1)
  const barStep = chartWidth / Math.max(series.length, 1)
  const pointStep = series.length > 1 ? chartWidth / (series.length - 1) : chartWidth
  const barWidth = Math.max(2, barStep * 0.64)
  const tickInterval = Math.max(1, Math.ceil(series.length / 12))
  const safeTitle = escapeXml(title.slice(0, 80))
  const total = series.reduce((sum, item) => sum + item.count, 0)
  const counts = series.map(item => item.count)
  const highest = counts.length ? Math.max(...counts) : 0
  const lowest = counts.length ? Math.min(...counts) : 0
  const averageText = String(Math.round(counts.length ? total / counts.length : 0))
  const summaryText = escapeXml(`Total: ${total} · High: ${highest} · Low: ${lowest} · Avg: ${averageText}`)
  const points = series.map((item, index) => {
    const x = padding.left + index * pointStep
    const y = padding.top + chartHeight - (item.count / maxCount) * chartHeight
    return { ...item, x, y }
  })

  let marks = ''
  let shape = ''
  for (let i = 0; i < series.length; i++) {
    const item = series[i]
    if (i % tickInterval === 0 || i === series.length - 1) {
      const labelX = chartType === 'bar'
        ? padding.left + i * barStep + barStep / 2
        : points[i].x
      marks += `<text x="${round(labelX)}" y="${height - 24}" text-anchor="middle" font-size="10" fill="#586069">${item.date.slice(5)}</text>`
    }
  }

  if (chartType === 'bar') {
    for (let i = 0; i < series.length; i++) {
      const item = series[i]
      const valueHeight = (item.count / maxCount) * chartHeight
      const x = padding.left + i * barStep + (barStep - barWidth) / 2
      const y = padding.top + chartHeight - valueHeight
      shape += `<rect x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(valueHeight)}" fill="${color}" opacity="0.86"/>`
    }
  } else {
    const pathData = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)},${round(point.y)}`).join(' ')
    if (chartType === 'area') {
      const first = points[0]
      const last = points[points.length - 1]
      shape += `<path d="${pathData} L${round(last.x)},${padding.top + chartHeight} L${round(first.x)},${padding.top + chartHeight} Z" fill="${color}" opacity="0.20"/>`
      shape += `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2.5"/>`
    } else if (chartType === 'line') {
      shape += `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="2.5"/>`
    } else {
      shape += `<path d="${pathData}" fill="none" stroke="${color}" stroke-width="1.6" opacity="0.55"/>`
      shape += points.map(point => `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="3.5" fill="${color}"/>`).join('')
    }
  }

  const yMarks = [0, 0.25, 0.5, 0.75, 1].map(ratio => {
    const y = padding.top + chartHeight - ratio * chartHeight
    const value = Math.round(maxCount * ratio)
    return `<line x1="${padding.left}" y1="${round(y)}" x2="${width - padding.right}" y2="${round(y)}" stroke="#eaeef2"/>
<text x="${padding.left - 10}" y="${round(y + 4)}" text-anchor="end" font-size="11" fill="#586069">${value}</text>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${safeTitle}">
  <rect width="100%" height="100%" fill="#fff"/>
  <text x="${width / 2}" y="28" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="700" fill="#24292f">${safeTitle}</text>
  <text x="${width / 2}" y="47" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#57606a">${summaryText}</text>
  ${yMarks}
  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#8c959f"/>
  <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}" stroke="#8c959f"/>
  ${marks}
  ${shape}
</svg>`
}

const UI_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#16243d;background:#f5f7fb;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;color:#182641;background:#f5f7fb}a{text-decoration:none;color:inherit}button,input,select{font:inherit}
[hidden]{display:none!important}a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #91b9ff;outline-offset:3px}
.top-nav{max-width:1200px;min-height:82px;margin:auto;padding:15px 26px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.03em;font-size:15px}.brand svg{width:26px;height:26px}
.brand-icon{width:42px;height:42px;display:grid;place-items:center;background:#e5eeff;border-radius:13px}
.brand small{display:block;font-size:11px;color:#8997ac;font-weight:500;letter-spacing:0;margin-top:3px}
.nav-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.nav-link{border-radius:9px;padding:10px 12px;font-size:13px;font-weight:650;color:#687891}
.nav-link:hover,.nav-link.active{background:#e8eef9;color:#235ed0}
.lang-switch{display:flex;border:1px solid #dfe6f0;border-radius:10px;background:white;padding:3px;gap:2px}
.lang-switch a{padding:7px 10px;border-radius:7px;font-size:12px;font-weight:800;color:#8c9ab0}
.lang-switch a.active{background:#e8f0ff;color:#245fdd}
.btn-primary,.btn-outline{display:inline-flex;justify-content:center;align-items:center;gap:8px;padding:12px 19px;border-radius:10px;font-size:13px;font-weight:750;border:1px solid #2465ec;cursor:pointer;background:#2465ec;color:white;box-shadow:0 5px 17px #2563eb1e}
.btn-primary:hover{background:#1651c7}.btn-outline{background:white;border-color:#dce4f0;color:#273a55;box-shadow:none}.btn-outline:hover{background:#f8faff}
.shell{max-width:1200px;margin:auto;padding:34px 26px 78px}.eyebrow{font-size:11px;color:#396ed9;font-weight:850;letter-spacing:.11em;text-transform:uppercase}
.surface{background:white;border:1px solid #e0e7f1;border-radius:18px;box-shadow:0 12px 35px #172e5708}
.site-footer{padding:25px;text-align:center;color:#8a99ab;font-size:12px;border-top:1px solid #e4eaf4}.site-footer a{color:#2d62d2;font-weight:700}
@media(max-width:720px){.top-nav{padding:14px 16px;gap:8px;flex-wrap:wrap}.brand{font-size:13px}.brand small{display:none}.nav-actions{gap:2px}.nav-link{padding:7px;font-size:12px}.shell{padding:20px 16px 56px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`
function uiLang(request) {
 const url = new URL(request.url)
 const language = url.searchParams.get('lang')
 if(language === 'en' || language === 'zh') return language
 return (request.headers?.get('Accept-Language')||'').toLowerCase().startsWith('zh')?'zh':'en'
}
function uiSwitch(url,lang) {
 const u1 = new URL(url);u1.searchParams.set('lang','en')
 const u2 = new URL(url);u2.searchParams.set('lang','zh')
 return `<nav class="lang-switch" aria-label="Language / 语言"><a lang="en" class="${lang==='en'?'active':''}" href="${escapeXml(u1.pathname+u1.search)}" aria-current="${lang==='en'?'page':'false'}">EN</a><a lang="zh-CN" class="${lang==='zh'?'active':''}" href="${escapeXml(u2.pathname+u2.search)}" aria-current="${lang==='zh'?'page':'false'}">中文</a></nav>`
}
function uiHeader(url,lang,current) {
 const t=(a,b)=>lang==='zh'?b:a
 return `<header class="top-nav"><a class="brand" href="/?lang=${lang}"><span class="brand-icon">${PROJECT_LOGO_SVG}</span><span>Cloudflare D1 Visit Counter<small>${t('Open-source · Self-hosted','开源 · 自托管')}</small></span></a>
 <div class="nav-actions"><a class="nav-link ${current==='home'?'active':''}" href="/?lang=${lang}">${t('Overview','项目首页')}</a><a class="nav-link ${current==='admin'?'active':''}" href="/admin?lang=${lang}">${t('Dashboard','管理后台')}</a><a class="nav-link" target="_blank" rel="noopener noreferrer" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter">GitHub ↗</a>${uiSwitch(url,lang)}</div></header>`
}


function renderLandingPage(request) {
 const lang=uiLang(request), t=(a,b)=>lang==='zh'?b:a, url=new URL(request.url)
 return `<!doctype html><html lang="${lang==='zh'?'zh-CN':'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <meta name="description" content="Self-hosted Cloudflare D1 visit counter. Open source, deploy your own instance.">
 <title>${t('Visitor badges. Your infrastructure.','访问徽章，由你掌控。')} · Cloudflare D1</title><link rel="icon" href="${FAVICON_HREF}">
 <style>${UI_CSS}
 .hero{display:grid;grid-template-columns:1.08fr .92fr;gap:54px;align-items:center;margin:26px 0 44px}
 .hero h1{font-size:clamp(39px,5.8vw,70px);letter-spacing:-.055em;line-height:1.07;margin:18px 0;color:#14223e}
 .hero h1 em{color:#2866e8;font-style:normal}.hero p{font-size:16px;color:#6f8098;line-height:1.85;max-width:630px}
 .hero-actions{display:flex;gap:11px;flex-wrap:wrap;margin-top:24px}
 .demo{padding:23px;box-shadow:0 28px 74px #294c891c}.demo-head{display:flex;justify-content:space-between;align-items:center;gap:8px;color:#7f8da1;font-size:11px;font-weight:800}
 .pill{padding:7px 10px;background:#ebf2ff;color:#2b65d9;border-radius:30px;font-size:10px}
 .demo-stage{display:flex;min-height:232px;align-items:center;justify-content:center;background:radial-gradient(circle at 35% 20%,#e8f1ff,#f8fafd 70%);border:1px solid #e8edf5;border-radius:14px;margin:20px 0}
 .demo-badge{display:flex;overflow:hidden;border-radius:5px;box-shadow:0 10px 25px #162b4c21;font-size:14px;font-weight:750}.demo-badge span,.demo-badge strong{padding:12px 17px}
 .demo-badge span{background:#dbeaff;color:#1c4a90}.demo-badge strong{background:#2866e8;color:white}
 .demo-badge.green span{background:#d9f5e6;color:#187553}.demo-badge.green strong{background:#208f68}.demo-badge.purple span{background:#eadefc;color:#6942ad}.demo-badge.purple strong{background:#7b54d6}
 .swatches{display:flex;gap:8px}.swatches button{padding:8px 12px;border:1px solid #dce4f1;border-radius:8px;background:white;font-size:12px;color:#718098;font-weight:750;cursor:pointer}
 .swatches button[aria-pressed=true]{border-color:#9fc0fa;background:#eff5ff;color:#2762da}
 .demo-note{font-size:12px!important;color:#8c9aae!important;margin:12px 0 0!important;line-height:1.65!important}
 .disclaimer{display:flex;gap:14px;padding:20px 23px;border-radius:14px;background:#edf3fe;border:1px solid #dce7fb;margin-bottom:53px}
 .disclaimer .i{display:grid;place-items:center;width:31px;height:31px;flex:none;border-radius:10px;background:#dceaff;color:#3068d5;font-weight:850}
 .disclaimer strong{font-size:14px;color:#234779}.disclaimer p{margin:6px 0 0;color:#637691;font-size:13px;line-height:1.7}
 .section-head{margin-bottom:23px}.section-head h2{font-size:27px;letter-spacing:-.03em;margin:9px 0 0}
 .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.item{padding:24px}.item .icon{display:grid;place-items:center;background:#eaf2ff;color:#356edf;border-radius:13px;width:40px;height:40px;font-size:20px}
 .item h3{font-size:16px;margin:20px 0 8px}.item p{font-size:13px;color:#7c8da5;line-height:1.75;margin:0}
 .steps{margin-top:55px}.step-number{color:#356fdf;font-size:12px;letter-spacing:.11em;font-weight:850}
 .item code{font-size:12px;background:#eff3f8;border:1px solid #e0e9f2;padding:2px 5px;border-radius:5px;overflow-wrap:anywhere}
 .bottom{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:34px 38px;margin-top:45px;color:white;border-radius:18px;background:linear-gradient(110deg,#214795,#2c6ee7)}
 .bottom h2{font-size:24px;margin:0 0 8px}.bottom p{margin:0;color:#d0e1ff;font-size:13px}.bottom .btn-primary{background:white;border-color:white;color:#2759b6}
 @media(max-width:850px){.hero{grid-template-columns:1fr;gap:24px}.cards{grid-template-columns:1fr}.bottom{align-items:flex-start;flex-direction:column}}
 </style></head><body>${uiHeader(url,lang,'home')}<main class="shell">
 <section class="hero"><div><div class="eyebrow">✦ ${t('OPEN SOURCE · SELF-HOSTED','开源 · 自托管')}</div>
 <h1>${t('Visitor badges.','访问量徽章，')}<br><em>${t('Your infrastructure.','由你自己掌控。')}</em></h1>
 <p>${t('An elegant visitor counter for GitHub READMEs and websites. Customize SVG badges, explore traffic trends, and own the data with Cloudflare Workers and D1.','面向 GitHub README 和网站的轻量级访问量工具。自定义 SVG 徽章、查看访问趋势，并使用 Cloudflare Workers 和 D1 自主管理数据。')}</p>
 <div class="hero-actions"><a class="btn-primary" target="_blank" rel="noopener noreferrer" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter#${lang==='zh'?'快速部署':'quick-start-deployment'}">${t('Deploy your own instance','部署自己的实例')} ↗</a><a class="btn-outline" href="/admin?lang=${lang}">${t('Open dashboard','进入管理后台')} →</a></div></div>
 <aside class="surface demo"><div class="demo-head"><span>${t('BADGE PREVIEW','徽章预览')}</span><span class="pill">${t('STATIC DEMO','静态示例')}</span></div>
 <div class="demo-stage"><div id="sampleBadge" class="demo-badge"><span>Visitors</span><strong>24 / 1,280</strong></div></div>
 <div class="swatches" role="group" aria-label="${t('Preview colors','预览配色')}"><button type="button" data-demo-theme="blue" aria-pressed="true">${t('Blue','蓝色')}</button><button type="button" data-demo-theme="green" aria-pressed="false">${t('Green','绿色')}</button><button type="button" data-demo-theme="purple" aria-pressed="false">${t('Purple','紫色')}</button></div>
 <p class="demo-note">${t('Illustrative data only; changing colors does not use backend resources or create a working badge.','模拟数据仅供预览；切换配色不会调用后台，也不会生成真实徽章。')}</p></aside></section>
 <aside class="disclaimer" role="note"><span class="i" aria-hidden="true">i</span><div><strong>${t('This is a showcase, not a free badge-hosting service.','本站仅供展示，不提供免费的徽章生成或后台托管服务。')}</strong><p>${t('Visitors cannot create public counters or use this deployment’s Worker compute and D1 storage. To generate real badges, deploy the open-source project in your own Cloudflare account and set your own Auth Code.','访客不能使用本站 Worker 计算与 D1 存储来创建新计数器。需要真实徽章，请在自己的 Cloudflare 账号部署开源项目并配置管理密码。')}</p></div></aside>
 <section><div class="section-head"><div class="eyebrow">${t('WHY SELF-HOST','为何选择自托管')}</div><h2>${t('All the essentials, owned by you.','功能完整，数据自主。')}</h2></div>
 <div class="cards"><article class="surface item"><span class="icon">◈</span><h3>${t('Owned infrastructure','独立基础设施')}</h3><p>${t('Run your own Worker and D1 database, with no shared counter storage.','使用自己的 Worker 和 D1 数据库，无需依赖公用计数平台。')}</p></article>
 <article class="surface item"><span class="icon">▦</span><h3>${t('Customizable badges','自定义徽章')}</h3><p>${t('Control badge style, labels, colors, and embed URLs.','自由设置徽章风格、标签、颜色和嵌入链接。')}</p></article>
 <article class="surface item"><span class="icon">⌁</span><h3>${t('Readable analytics','清晰的统计分析')}</h3><p>${t('View trends, manage counter keys, and preserve your history.','查看访问趋势、维护计数器链接，并保留历史数据。')}</p></article></div></section>
 <section class="steps" id="get-started"><div class="section-head"><div class="eyebrow">${t('GET STARTED','快速开始')}</div><h2>${t('Deploy in three steps.','只需三步即可部署。')}</h2></div>
 <div class="cards"><article class="surface item"><span class="step-number">01 / SOURCE</span><h3>${t('Get the code','获取源码')}</h3><p>${t('Clone the GitHub repository or copy','克隆 GitHub 仓库或复制')} <code>worker.js</code>。</p></article>
 <article class="surface item"><span class="step-number">02 / DATABASE</span><h3>${t('Create your D1 database','创建 D1 数据库')}</h3><p>${t('Initialize the counters table and configure binding','初始化 counters 数据表，并配置绑定')} <code>HITS</code>。</p></article>
 <article class="surface item"><span class="step-number">03 / DEPLOY</span><h3>${t('Configure your Worker','配置并发布 Worker')}</h3><p>${t('Set','配置')} <code>ALLOWED_DOMAIN</code> ${t('and','以及')} <code>AUTH_CODE</code>，${t('then deploy to your own hostname.','随后发布到自己的域名。')}</p></article></div></section>
 <section class="bottom"><div><h2>${t('Make it yours.','开始搭建你的计数器。')}</h2><p>${t('Open source, self-hosted, and built for long-term use.','开源、自托管，适合长期使用。')}</p></div><a class="btn-primary" target="_blank" rel="noopener noreferrer" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter">${t('Explore on GitHub','前往 GitHub 查看源码')} ↗</a></section>
 </main><footer class="site-footer">Cloudflare D1 Visit Counter · ${t('Open-source · Self-hosted','开源 · 自托管')} · <a href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter">GitHub ↗</a></footer>
 <script>for(const b of document.querySelectorAll('[data-demo-theme]'))b.addEventListener('click',()=>{const n=document.getElementById('sampleBadge');n.className='demo-badge'+(b.dataset.demoTheme==='blue'?'':' '+b.dataset.demoTheme);for(const e of document.querySelectorAll('[data-demo-theme]'))e.setAttribute('aria-pressed',String(e===b))})</script>
 </body></html>`
}

function renderGeneratorPage(request) {
  const lang=uiLang(request), t=(en,zh)=>lang==='zh'?zh:en
  return `<!doctype html>
<html lang="${lang==='zh'?'zh-CN':'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t("Private dashboard","私有管理后台")} · Cloudflare D1 Visit Counter</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f8fa; color: #24292f; }
    main { max-width: 1120px; margin: 0 auto; padding: 36px 18px 56px; }
    h1 { margin: 0 0 8px; font-size: 32px; letter-spacing: 0; }
    .product-head { margin-bottom: 28px; padding-top: 6px; text-align: center; }
    .brand-title-row { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
    .project-logo { width: 54px; height: 54px; flex: 0 0 auto; display: block; }
    .powered-title { color: #24292f; font-size: clamp(36px, 5vw, 52px); font-weight: 850; letter-spacing: 0; line-height: 1.12; }
    .powered-title a { color: #0969da; text-decoration: none; }
    .powered-title a:hover { text-decoration: underline; }
    .powered-prefix { color: #24292f; font-weight: 650; }
    p { color: #57606a; line-height: 1.65; }
    .panel { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 20px; margin-top: 18px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    .color-row { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .output-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
    .copy-btn { min-height: 34px; background: #24292f; white-space: nowrap; }
    .danger-btn { background: #cf222e; }
    .secondary-btn { background: #57606a; }
    .counter-list { display: grid; gap: 8px; margin-top: 10px; }
    .counter-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .counter-item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto auto; gap: 8px; align-items: center; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; background: #f6f8fa; }
    .counter-name { overflow-wrap: anywhere; font-weight: 700; }
    .counter-total { color: #57606a; font-size: 12px; margin-top: 6px; }
    .saved-badge-img { display: block; width: max-content; max-width: 100%; height: auto; margin-top: 6px; }
    .saved-badge { display: inline-flex; align-items: center; min-height: 20px; border-radius: 3px; overflow: hidden; font-family: Verdana,Geneva,DejaVu Sans,sans-serif; font-size: 11px; line-height: 1; }
    .saved-badge-label { background: #A4D3EE; color: #24292f; padding: 5px 7px; font-weight: 400; }
    .saved-badge-count { background: #555555; color: #fff; padding: 5px 7px; }
    .saved-badge-flat-square, .saved-badge-for-the-badge { border-radius: 0; }
    .saved-badge-for-the-badge { min-height: 28px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .saved-badge-for-the-badge .saved-badge-label, .saved-badge-for-the-badge .saved-badge-count { padding: 8px 9px; }
    .saved-badge-social { background: #fff; border: 1px solid #d0d7de; box-shadow: none; }
    .status-preview { margin-top: 12px; border: 1px dashed #d0d7de; border-radius: 8px; background: #f6f8fa; padding: 14px; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .stat { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; }
    .stat strong { display: block; font-size: 22px; }
    .stat span { color: #57606a; font-size: 12px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 650; }
    .field-title { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
    .field-note { color: #57606a; font-size: 12px; font-weight: 500; text-align: right; }
    input, select { min-height: 38px; border: 1px solid #d0d7de; border-radius: 6px; padding: 0 10px; font: inherit; }
    button { min-height: 40px; border: 0; border-radius: 6px; background: #0969da; color: #fff; font-weight: 700; padding: 0 14px; cursor: pointer; }
    code { display: block; overflow-wrap: anywhere; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; color: #24292f; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
    .mode-row { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mode-label { color: #57606a; font-size: 12px; font-weight: 700; }
    .segmented { display: inline-flex; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; background: #fff; }
    .segmented button { min-height: 32px; border-radius: 0; background: #fff; color: #57606a; border-left: 1px solid #d0d7de; padding: 0 10px; }
    .segmented button:first-child { border-left: 0; }
    .segmented button.active { background: #0969da; color: #fff; }
    .preview { min-height: 34px; display: flex; align-items: center; }
    .hint { margin: 8px 0 0; font-size: 12px; color: #57606a; }
    .empty { color: #6e7781; font-style: italic; }
    .color-field { position: relative; display: grid; gap: 6px; font-size: 13px; font-weight: 650; }
    .color-button { min-height: 38px; border: 1px solid #d0d7de; border-radius: 6px; padding: 0 12px; color: #fff; font-weight: 700; text-shadow: none; }
    .color-popover { position: absolute; z-index: 20; top: 66px; left: 0; width: 196px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; box-shadow: 0 12px 28px rgba(31,35,40,.18); padding: 10px; display: none; }
    .color-popover.open { display: block; }
    .color-popover::before { content: ""; position: absolute; top: -8px; left: 90px; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 8px solid #555; }
    .color-large { height: 78px; border-radius: 4px 4px 0 0; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; text-shadow: none; }
    .palette { display: grid; grid-template-columns: repeat(6, 22px); gap: 9px; padding: 10px 0; }
    .swatch { width: 22px; height: 22px; min-height: 22px; border: 0; border-radius: 4px; padding: 0; box-shadow: inset 0 0 0 1px rgba(0,0,0,.06); }
    .hex-input { width: 100%; box-sizing: border-box; min-height: 30px; font-size: 12px; }
    .toast { position: fixed; right: 18px; bottom: 18px; z-index: 50; background: #24292f; color: #fff; border-radius: 6px; padding: 10px 12px; font-size: 13px; font-weight: 700; box-shadow: 0 10px 24px rgba(31,35,40,.18); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .18s ease, transform .18s ease; }
    .toast.show { opacity: 1; transform: translateY(0); }

    /* Public landing: informative by default, self-hosting first. */
    body { background: radial-gradient(ellipse at 12% -8%, #e3efff 0%, transparent 38%), #f6f8fa; }
    main { max-width: 1120px; }
    .site-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 34px; }
    .site-brand { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 800; letter-spacing: -.02em; }
    .site-brand svg { width: 34px; height: 34px; }
    .site-brand small { display: block; color: #57606a; font-size: 11px; font-weight: 500; letter-spacing: 0; }
    a { color: #0969da; }
    .site-link, .cta { display: inline-flex; justify-content: center; align-items: center; gap: 8px; font-weight: 700; text-decoration: none; }
    .site-link { border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 13px; background: white; font-size: 13px; color: #24292f; }
    .landing { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, .85fr); align-items: center; gap: 34px; padding: 16px 0 28px; }
    .eyebrow { display: inline-flex; align-items: center; gap: 7px; color: #0969da; text-transform: uppercase; font-size: 11px; letter-spacing: .09em; font-weight: 800; }
    .dot { width: 7px; height: 7px; background: #2da44e; border-radius: 50%; }
    .landing h1 { font-size: clamp(38px, 5vw, 60px); line-height: 1.08; letter-spacing: -.055em; margin: 18px 0; }
    .landing h1 span { color: #0969da; }
    .lead { max-width: 640px; color: #57606a; font-size: 16px; line-height: 1.7; }
    .cta-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0; }
    .cta { border-radius: 8px; padding: 13px 17px; font-size: 14px; }
    .cta-primary { background: #0969da; color: white; }
    .cta-secondary { border: 1px solid #d0d7de; color: #24292f; background: white; }
    .usage-note { border-left: 3px solid #bf8700; background: #fff8e6; color: #5f4b15; padding: 12px 15px; border-radius: 0 8px 8px 0; line-height: 1.65; font-size: 13px; }
    .usage-note strong { display: block; margin-bottom: 3px; }
    .sample-card { background: #fff; border: 1px solid #d0d7de; border-radius: 16px; padding: 24px; box-shadow: 0 15px 40px rgba(36,41,47,.06); }
    .sample-label { font-size: 12px; color: #57606a; font-weight: 700; }
    .sample-stage { display: grid; min-height: 140px; place-items: center; margin: 16px 0; border: 1px dashed #d0d7de; background: #f6f8fa; border-radius: 10px; }
    .sample-badge { display: inline-flex; overflow: hidden; border-radius: 4px; font-family: Verdana,Geneva,sans-serif; font-size: 13px; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,.06); }
    .sample-badge span, .sample-badge strong { padding: 9px 12px; font-weight: 600; }
    .sample-badge span { background: #dbeafe; color: #1e3a8a; }
    .sample-badge strong { color: #fff; background: #0969da; }
    .sample-badge.green span { background: #dcfce7; color: #166534; }
    .sample-badge.green strong { background: #238636; }
    .sample-badge.purple span { background: #f3e8ff; color: #6b21a8; }
    .sample-badge.purple strong { background: #8250df; }
    .demo-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
    .demo-controls button { min-height: 30px; font-size: 12px; padding: 3px 11px; background: #f6f8fa; border: 1px solid #d0d7de; color: #24292f; }
    .demo-controls button[aria-pressed="true"] { border-color: #0969da; color: #0969da; background: #eef5ff; }
    .demo-caption { color: #57606a; font-size: 12px; line-height: 1.6; }
    .steps { margin: 20px 0 32px; }
    .section-head { margin: 0 0 14px; font-size: 19px; letter-spacing: -.02em; }
    .step-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
    .step { padding: 18px; background: #fff; border: 1px solid #d0d7de; border-radius: 10px; }
    .step .step-num { display: inline-grid; place-items: center; background: #eef5ff; color: #0969da; width: 27px; height: 27px; border-radius: 8px; font-size: 12px; font-weight: 800; }
    .step h3 { margin: 12px 0 7px; font-size: 15px; }
    .step p { margin: 0; font-size: 13px; }
    .workspace-details { border: 1px solid #d0d7de; border-radius: 12px; background: rgba(255,255,255,.77); padding: 0 18px 18px; }
    .workspace-details summary { list-style-position: inside; cursor: pointer; padding: 22px 2px; font-weight: 800; font-size: 17px; }
    .workspace-details summary small { color: #57606a; font-size: 12px; font-weight: 400; display: block; margin: 7px 0 0 24px; line-height: 1.5; }
    .workspace-details > .panel { margin-top: 0; margin-bottom: 14px; }
    .workspace-details > .panel:last-of-type { margin-bottom: 0; }
    .owner-hint { padding: 9px 11px; background: #eef5ff; border-radius: 7px; color: #345071; font-size: 12px; margin-bottom: 14px; }
    .edit-banner { background: #eef5ff; border: 1px solid #b6d6fa; border-radius: 7px; padding: 10px 12px; margin: 10px 0; font-size: 13px; }
    .footer { text-align: center; padding: 30px 8px 8px; font-size: 12px; color: #57606a; }
    button:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid #54aeff; outline-offset: 3px; }
    button[hidden], p[hidden] { display: none; }
    @media (max-width: 760px) {
      main { padding: 22px 14px 38px; }
      .landing { grid-template-columns: minmax(0,1fr); gap: 16px; }
      .step-grid { grid-template-columns: 1fr; }
      .site-head { margin-bottom: 14px; }
      .site-brand { font-size: 13px; }
      .sample-stage { min-height: 108px; }
      .workspace-details { padding: 0 12px 12px; }
      .workspace-details .panel { padding: 14px; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .powered-title { font-size: 32px; } .counter-item { grid-template-columns: auto minmax(0, 1fr); } .counter-item button { width: 100%; } .field-title { align-items: flex-start; flex-direction: column; gap: 2px; } .field-note { text-align: left; } }

    /* Dashboard: dedicated owner workspace with persistent navigation. */
    ${UI_CSS}
    body { background:#f5f7fb; }
    main {max-width:none;margin:0;padding:0}
    .admin-layout{max-width:1360px;margin:auto;display:grid;grid-template-columns:242px minmax(0,1fr);gap:28px;padding:25px 26px 70px}
    .admin-aside{border:1px solid #e0e6f0;border-radius:18px;background:#fff;padding:22px;align-self:start;position:sticky;top:22px}
    .aside-eyebrow{color:#93a0b4;font-size:10px;letter-spacing:.12em;font-weight:800;margin:0 0 18px}
    .aside-link{display:flex;align-items:center;gap:11px;border-radius:10px;color:#6c7c95;padding:12px 14px;font-size:13px;font-weight:700;margin:3px 0}
    .aside-link:hover,.aside-link.active{background:#eaf1ff;color:#2563eb}
    .aside-link .side-icon{font-size:18px;width:20px;text-align:center}
    .aside-note{padding:15px;margin-top:28px;background:#f0f5fd;border-radius:12px;color:#60738e;font-size:12px;line-height:1.65}
    .aside-note strong{color:#3868c6;display:block;margin-bottom:5px}
    .admin-main{min-width:0}
    .admin-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin:5px 0 24px}
    .admin-head h1{font-size:clamp(28px,3.5vw,38px);letter-spacing:-.04em;margin:6px 0 8px}
    .admin-head p{color:#8190a5;font-size:13px;margin:0;line-height:1.55}
    .private-tag{white-space:nowrap;color:#326bd5;background:#e7f0ff;border:1px solid #d1e1ff;padding:9px 12px;border-radius:30px;font-weight:750;font-size:11px}
    .gate{padding:26px 28px;margin-bottom:22px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:18px}
    .gate-header{grid-column:1/-1}.gate-header h2{margin:0 0 6px;font-size:18px}.gate-header p{font-size:12px;color:#7d8da4;line-height:1.6;margin:0}
    .gate label{max-width:460px}.gate #authCode{width:100%;background:#f9fbfe}
    .gate button{white-space:nowrap;height:42px}
    .stats-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:22px}
    .stat-tile{padding:23px;border-radius:15px;background:#fff;border:1px solid #e1e8f3}
    .stat-tile span{display:block;font-size:12px;color:#8190a5;font-weight:650}
    .stat-tile strong{display:block;margin-top:7px;font-size:32px;letter-spacing:-.05em;color:#1f3150}
    .admin-workgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;margin-bottom:18px;align-items:start}
    .admin-main .panel{margin:0;padding:24px;border-radius:16px;box-shadow:none;border:1px solid #e0e7f1;background:#fff;min-width:0}
    .admin-main .panel h2{font-size:18px;letter-spacing:-.025em;margin:0 0 15px}
    .admin-main .panel-title{color:#7789a0;font-size:12px;margin:-8px 0 20px;line-height:1.6}
    .admin-main label{color:#52627a;font-weight:700;font-size:12px}
    .admin-main input,.admin-main select{border:1px solid #dce4f0;background:#f9fbfe;border-radius:9px;min-height:43px;width:100%;color:#193050}
    .admin-main input:focus,.admin-main select:focus{border-color:#7ea8f5;outline:3px solid #dfeafe}
    .admin-main .grid{grid-template-columns:1fr 1fr}
    .admin-main .color-row{gap:12px}
    .admin-main .color-button{border-radius:9px;width:100%;min-height:43px}
    .admin-main button{border-radius:9px}
    .admin-main .actions{margin-top:22px}
    .admin-main .actions button{flex:1}
    .admin-main .copy-btn{background:#ebf1fb;border:1px solid #d7e3f6;color:#2758b4}
    .admin-main .copy-btn:hover{background:#dae8ff}
    .admin-main .secondary-btn{background:#f1f5fb;color:#34506d;border:1px solid #dae2ef}
    .admin-main .danger-btn{background:#fff1f0;color:#bf3340;border:1px solid #ffd0d1}
    .admin-main code{border:1px solid #e3e9f4;background:#f8fafd;border-radius:9px;font-size:12px;line-height:1.65;white-space:pre-wrap}
    .admin-main .counter-item{background:#fff;grid-template-columns:auto minmax(0,1fr) repeat(3,auto);border-color:#e3e9f2;border-radius:12px;padding:14px}
    .admin-main .counter-item button{font-size:12px;padding:8px 12px;min-height:35px}
    .admin-main .counter-name{font-size:13px;color:#213653}
    .admin-main .counter-total{font-size:12px}
    .admin-main .output-row{margin-bottom:15px}
    .admin-main .mode-row{margin-bottom:14px}
    .admin-main .preview{flex-wrap:wrap;gap:10px}
    .admin-main .hint{line-height:1.65}
    .owner-tip{font-size:12px;color:#6e829c;border-left:3px solid #719af0;padding:10px 13px;background:#f2f6ff;border-radius:0 8px 8px 0;margin-bottom:20px}
    #counterListPanel{margin-top:18px}
    .admin-main .counter-list{margin-top:18px}
    .admin-main .counter-toolbar{margin-top:18px}
    @media(max-width:1030px){.admin-layout{grid-template-columns:1fr}.admin-aside{position:static;display:flex;flex-wrap:wrap;gap:7px;align-items:center;padding:12px}.aside-eyebrow,.aside-note{display:none}.aside-link{margin:0}}
    @media(max-width:720px){.admin-layout{padding:14px 14px 42px;gap:14px}.admin-workgrid,.stats-overview{grid-template-columns:1fr}.gate{grid-template-columns:1fr;padding:18px}.admin-main .panel{padding:18px}.admin-head{align-items:start;flex-direction:column}.admin-main .counter-item{grid-template-columns:auto minmax(0,1fr)}}
  </style>
</head>
<body>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <div id="dashboardRoot">

    ${uiHeader(new URL(request.url),lang,'admin')}
    <div class="admin-layout">
      <aside class="admin-aside" aria-label="${t('Workspace navigation','工作区导航')}">
        <div class="aside-eyebrow">${t('WORKSPACE','管理工作区')}</div>
        <a class="aside-link active" href="#overviewPanel"><span class="side-icon">◫</span>${t('Overview','概览')}</a>
        <a class="aside-link" href="#editorPanel"><span class="side-icon">✎</span>${t('Badge editor','徽章编辑')}</a>
        <a class="aside-link" href="#counterListPanel"><span class="side-icon">▦</span>${t('My counters','已有计数器')}</a>
        <a class="aside-link" href="#embedPanel"><span class="side-icon">⌘</span>${t('Embed codes','嵌入代码')}</a>
        <div class="aside-note"><strong>${t('Private workspace','私有管理空间')}</strong>${t('Your Auth Code is required. Visitors must deploy their own instance to create badges.','所有管理操作都需要 Auth Code。访客需自行部署才能创建徽章。')}</div>
      </aside>
      <main class="admin-main">
        <div class="admin-head"><div><span class="eyebrow">${t('OWNER CONSOLE','站长控制台')}</span><h1>${t('Counter dashboard','计数器管理后台')}</h1><p>${t('Create, customize and maintain your badges from one place.','在一个工作区中创建、编辑和维护所有访问量徽章。')}</p></div><span class="private-tag">● ${t('Private · Auth required','私有 · 需要验证')}</span></div>
        <section class="surface gate" id="authGate"><div class="gate-header"><h2>${t('Unlock your workspace','解锁管理工作区')}</h2><p>${t('Use the Auth Code configured when you deployed your own Worker. Credentials are never stored in the browser.','输入部署 Worker 时设置的 Auth Code。管理密码不会保存在浏览器中。')}</p></div>
          <label>${t('Auth Code','管理密码')}<input id="authCode" type="password" autocomplete="off" placeholder="${t('Enter deployment Auth Code','输入部署时设置的管理密码')}"></label>
          <button id="loadCounters" type="button">${t('Unlock & load','解锁并加载')} →</button>
        </section>
        <div id="workspaceContent" hidden>
          <section id="overviewPanel" class="stats-overview" aria-label="${t('Counters summary','计数器汇总')}">
            <div class="stat-tile"><span>${t('Total counters','计数器总数')}</span><strong id="counterCount">0</strong></div>
            <div class="stat-tile"><span>${t('Total visits','累计访问量')}</span><strong id="visitCount">0</strong></div>
            <div class="stat-tile"><span>${t('Visits today','今日访问量')}</span><strong id="todayCount">0</strong></div>
          </section>
          <div class="admin-workgrid">
    <section class="panel" id="editorPanel">
      <h2>${t('Create or edit badge','创建与编辑徽章')}</h2>
      <p class="panel-title">${t('Configure a counter and preview how it will look.','配置计数器，并实时预览徽章样式。')}</p>
      <div class="grid">
        <label style="grid-column: 1 / -1;">Auth Code<input id="authCode" type="password" placeholder="Deploy your own Worker and configure AUTH_CODE in worker.js to unlock all features"></label>
        <label><span class="field-title"><span>${t('Counter URL / key','计数器地址 / Key')}</span><span class="field-note">${t('Supports full URLs and custom keys','支持完整 URL 和自定义 Key')}</span></span><input id="source"></label>
        <label><span class="field-title"><span>${t('Badge label','徽章标签')}</span><span class="field-note"></span></span><input id="label"></label>
        <div class="color-row">
        <div class="color-field" data-color-field="labelColor">
          <span>${t('Label color','标签颜色')}</span>
          <button class="color-button" type="button" id="labelColorButton">${t('Choose color','选择颜色')}</button>
          <div class="color-popover" id="labelColorPanel">
            <div class="color-large" id="labelColorLarge">#A4D3EE</div>
            <div class="palette" id="labelColorPalette"></div>
            <input class="hex-input" id="labelColor" value="#A4D3EE">
          </div>
        </div>
        <div class="color-field" data-color-field="countColor">
          <span>${t('Count color','计数颜色')}</span>
          <button class="color-button" type="button" id="countColorButton">${t('Choose color','选择颜色')}</button>
          <div class="color-popover" id="countColorPanel">
            <div class="color-large" id="countColorLarge">#555555</div>
            <div class="palette" id="countColorPalette"></div>
            <input class="hex-input" id="countColor" value="#555555">
          </div>
        </div>
        </div>
        <label>${t('Badge style','徽章样式')}
          <select id="style">
            <option value="flat">flat</option>
            <option value="flat-square">flat-square</option>
            <option value="plastic">plastic</option>
            <option value="for-the-badge">for-the-badge</option>
            <option value="social">social</option>
          </select>
        </label>
        <label>${t('Badge type','徽章类型')}
          <select id="labelStyle">
            <option value="default">${t('today / total','今日 / 累计')}</option>
            <option value="none">${t('total only','仅累计')}</option>
          </select>
        </label>
      </div>
      <p class="hint">${t('The URL identifies stored data; the badge label changes only the display. Choose Edit below to migrate an existing URL without losing counts.','URL 是统计数据的唯一标识；Badge Label 只改变显示文字。通过下方编辑操作可以迁移 URL 并保留访问量。')}</p>
      <p class="edit-banner" id="editNotice" hidden aria-live="polite">${t('Editing an existing counter. Changing its URL migrates total visits, daily history and styling while keeping old key links compatible.','正在编辑已有计数器。修改 URL 会保留累计量、历史趋势与徽章样式，旧 Key 链接继续兼容。')}</p>
      <div class="actions">
        <button id="create">${t('Create counter','创建计数器')}</button><button id="saveCounter" type="button" hidden>${t('Save changes','保存修改')}</button><button id="cancelEdit" type="button" class="secondary-btn" hidden>${t('Cancel','取消')}</button>
        <div class="preview"><img id="badgePreview" alt=""><a id="statusLink" href="#" target="_blank" rel="noopener noreferrer" style="display:none; margin-left:12px; color:#0969da; font-weight:700;">${t('View analytics','查看统计')}</a></div>
      </div>
    </section>
    <section class="panel" id="embedPanel">
      <h2>${t('Embed & share','嵌入与分享')}</h2><p class="panel-title">${t('Copy the generated Markdown or HTML after saving your counter.','保存计数器后，即可复制 Markdown 或 HTML 嵌入代码。')}</p>
      <div class="mode-row"><span class="mode-label">${t('Link mode','链接模式')}</span><div class="segmented"><button id="savedMode" class="active" type="button">${t('Saved style','保存的样式')}</button><button id="customMode" type="button">${t('Custom URL','自定义链接')}</button></div></div>
      <p>${t('Markdown · badge','Markdown · 徽章')}</p><div class="output-row"><code id="markdownCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="markdownCode">${t('Copy','复制')}</button></div>
      <p>${t('Markdown · linked to analytics','Markdown · 链接到统计')}</p><div class="output-row"><code id="markdownLinkCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="markdownLinkCode">${t('Copy','复制')}</button></div>
      <p>${t('HTML · linked to analytics','HTML · 链接到统计')}</p><div class="output-row"><code id="htmlCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="htmlCode">${t('Copy','复制')}</button></div>
      <p>${t('Image URL','徽章图片链接')}</p><div class="output-row"><code id="imageUrlCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="imageUrlCode">${t('Copy','复制')}</button></div><p>${t('Analytics URL','统计详情链接')}</p><div class="output-row"><code id="statusUrlCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="statusUrlCode">${t('Copy','复制')}</button></div>
    </section>
          </div>
    <section class="panel" id="counterListPanel">
      <h2>${t('Created counters','已创建的计数器')}</h2>
      <p class="hint">${t('Use loads saved links; Edit changes the key and style while preserving counts. Deletion is permanent. All actions require authorization.','使用可加载已有链接；编辑可调整地址与样式并保留统计；删除不可恢复。所有管理操作都需要验证。')}</p>
      <div class="counter-toolbar"><button id="selectAllCounters" class="secondary-btn" type="button">${t('Select all','全选')}</button><button id="deleteSelectedCounters" class="danger-btn" type="button">${t('Delete selected','删除选中')}</button></div>
      <div id="counterList" class="counter-list"><span class="empty">${t('Unlock to view your counters.','验证后查看已创建计数器。')}</span></div>
    </section>
        </div>
      </main>
    </div>
    <footer class="site-footer">Cloudflare D1 Visit Counter · ${t('Private self-hosted workspace','私有自托管工作区')} · <a href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter">GitHub ↗</a></footer>
  </div>
  <script>
    const LANG = '${lang}'
    const tr = (en,zh) => LANG === 'zh' ? zh : en
    const domain = location.host
    const $ = id => document.getElementById(id)
    let createdCounter = ''
    let currentCounts = { daily: 0, total: 0 }
    let outputMode = 'saved'
    let editingCounter = ''
    const paletteColors = ['#D8E3F0', '#F87171', '#64748B', '#2ECC71', '#33C2D8', '#555555', '#E1E95B', '#FF8A65', '#B46AD1', '#A4D3EE', '#FFB6C1', '#FFFFFF']
    function sourceValue() { return $('source').value.trim() }
    function counterValue() { return sourceValue() }
    function normalizeHex(value, fallback) {
      const raw = String(value || '').trim()
      if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase()
      if (/^[0-9a-fA-F]{6}$/.test(raw)) return ('#' + raw).toUpperCase()
      return fallback
    }
    function readableTextColor(hex) {
      const value = normalizeHex(hex, '#555555').slice(1)
      const r = parseInt(value.slice(0, 2), 16)
      const g = parseInt(value.slice(2, 4), 16)
      const b = parseInt(value.slice(4, 6), 16)
      return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#24292f' : '#fff'
    }
    function setPickerColor(id, value) {
      const fallback = id === 'countColor' ? '#555555' : '#A4D3EE'
      const color = normalizeHex(value, fallback)
      const input = $(id)
      const button = $(id + 'Button')
      const large = $(id + 'Large')
      input.value = color
      button.style.background = color
      button.style.color = readableTextColor(color)
      large.style.background = color
      large.style.color = readableTextColor(color)
      large.textContent = color
      updateOutputs(counterValue())
    }
    function setupColorPicker(id) {
      const panel = $(id + 'Panel')
      const button = $(id + 'Button')
      const input = $(id)
      const palette = $(id + 'Palette')
      for (const color of paletteColors) {
        const swatch = document.createElement('button')
        swatch.type = 'button'
        swatch.className = 'swatch'
        swatch.style.background = color
        swatch.title = color
        swatch.addEventListener('click', () => setPickerColor(id, color))
        palette.appendChild(swatch)
      }
      button.addEventListener('click', () => {
        for (const other of document.querySelectorAll('.color-popover.open')) {
          if (other !== panel) other.classList.remove('open')
        }
        panel.classList.toggle('open')
      })
      input.addEventListener('input', () => setPickerColor(id, input.value))
      setPickerColor(id, input.value)
    }
    function showToast(message) {
      const toast = $('toast')
      toast.textContent = message
      toast.classList.add('show')
      clearTimeout(showToast.timer)
      showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800)
    }
    function imageUrl(counter) {
      const params = new URLSearchParams({
        path: counter,
      })
      return 'https://' + domain + '/api/combined?' + params.toString()
    }
    function customImageUrl(counter) {
      const params = new URLSearchParams({
        path: counter,
        label: $('label').value || 'Visitors',
        labelColor: $('labelColor').value || '#A4D3EE',
        countColor: $('countColor').value || '#555555',
        style: $('style').value,
        labelStyle: $('labelStyle').value,
      })
      return 'https://' + domain + '/api/combined?' + params.toString()
    }
    // Render saved / edited badge previews entirely in the browser.
    // No unauthenticated preview API, D1 query or public badge generator.
    function previewImageUrl(counter, config = {}, counts = {}) {
      const label = String(config.label || $('label').value || 'Visitors').slice(0, 48)
      const style = config.style || $('style').value || 'flat'
      const labelStyle = config.labelStyle || $('labelStyle').value || 'default'
      const leftText = style === 'for-the-badge' ? label.toUpperCase() : label
      const rightText = labelStyle === 'none'
        ? String(counts.total || 0)
        : String(counts.daily || 0) + ' / ' + String(counts.total || 0)
      const textWidth = value => Math.max(28, 10 + [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 14 : 7), 0))
      const big = style === 'for-the-badge'
      const h = big ? 28 : 20
      const leftWidth = textWidth(leftText) + (big ? 14 : 0)
      const rightWidth = textWidth(rightText) + (big ? 14 : 0)
      const w = leftWidth + rightWidth
      const radius = style === 'flat-square' || big ? 0 : 3
      const labelBg = style === 'social' ? '#FFFFFF' : normalizeHex(config.labelColor || $('labelColor').value, '#A4D3EE')
      const countBg = normalizeHex(config.countColor || $('countColor').value, '#555555')
      const labelFg = style === 'social' ? '#24292F' : readableTextColor(labelBg)
      const countFg = readableTextColor(countBg)
      const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img">' +
        '<defs><clipPath id="clip"><rect width="' + w + '" height="' + h + '" rx="' + radius + '"/></clipPath></defs>' +
        '<g clip-path="url(#clip)"><rect width="' + leftWidth + '" height="' + h + '" fill="' + labelBg + '"/>' +
        '<rect x="' + leftWidth + '" width="' + rightWidth + '" height="' + h + '" fill="' + countBg + '"/></g>' +
        '<g font-family="Verdana,Geneva,sans-serif" font-size="' + (big ? 12 : 11) + '" text-anchor="middle" font-weight="' + (big ? '700' : '400') + '">' +
        '<text x="' + Math.floor(leftWidth / 2) + '" y="' + (big ? 18 : 14) + '" fill="' + labelFg + '">' + esc(leftText) + '</text>' +
        '<text x="' + (leftWidth + Math.floor(rightWidth / 2)) + '" y="' + (big ? 18 : 14) + '" fill="' + countFg + '">' + esc(rightText) + '</text></g></svg>'
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    }
    function statusUrl(counter) {
      return 'https://' + domain + '/status?path=' + encodeURIComponent(counter)
    }
    function clearOutputs(message = 'Create or select a counter first.') {
      for (const id of ['markdownCode', 'markdownLinkCode', 'htmlCode', 'imageUrlCode', 'statusUrlCode']) {
        const node = $(id)
        node.textContent = message
        node.classList.add('empty')
      }
      $('badgePreview').removeAttribute('src')
      $('statusLink').style.display = 'none'
    }
    function setCode(id, text) {
      const node = $(id)
      node.textContent = text
      node.classList.remove('empty')
    }
    function updateOutputs(counter, counts) {
      if (!counter || counter !== createdCounter) return
      if (counts) currentCounts = { daily: Number(counts.daily) || 0, total: Number(counts.total) || 0 }
      const image = outputMode === 'custom' ? customImageUrl(counter) : imageUrl(counter)
      const status = statusUrl(counter)
      $('badgePreview').src = previewImageUrl(counter, {}, currentCounts)
      setCode('markdownCode', '![' + counter + '](' + image + ')')
      setCode('markdownLinkCode', '[![' + counter + '](' + image + ')](' + status + ')')
      setCode('htmlCode', '<a href="' + status + '" target="_blank" rel="noopener noreferrer"><img src="' + image + '" alt="Visitor badge" /></a>')
      setCode('imageUrlCode', image)
      setCode('statusUrlCode', status)
      $('statusLink').href = status
      $('statusLink').style.display = 'inline-block'
    }
    function renderCounterList(counters) {
      const list = $('counterList')
      list.innerHTML = ''
      if (!counters.length) {
        list.innerHTML = '<span class="empty">' + tr('No counters created yet.','尚未创建任何计数器。') + '</span>'
        $('counterCount').textContent='0'
        $('visitCount').textContent='0'
        $('todayCount').textContent='0'
        return
      }
      $('counterCount').textContent = counters.length.toLocaleString()
      $('visitCount').textContent = counters.reduce((n,v)=>n+(Number(v.total)||0),0).toLocaleString()
      $('todayCount').textContent = counters.reduce((n,v)=>n+(Number(v.daily)||0),0).toLocaleString()
      for (const item of counters) {
        const row = document.createElement('div')
        row.className = 'counter-item'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.className = 'counter-select'
        checkbox.value = item.counter
        checkbox.setAttribute('aria-label', 'Select counter ' + item.counter)
        const info = document.createElement('div')
        const name = document.createElement('div')
        name.className = 'counter-name'
        name.textContent = item.counter
        const config = item.config || {}
        const badge = document.createElement('img')
        badge.className = 'saved-badge-img'
        badge.src = previewImageUrl(item.counter, config, { daily: item.daily || 0, total: item.total || 0 })
        badge.alt = 'Saved badge preview'
        const total = document.createElement('div')
        total.className = 'counter-total'
        total.textContent = tr('Total visits: ','累计访问：') + Number(item.total).toLocaleString()
        info.append(name, badge, total)
        const useButton = document.createElement('button')
        useButton.type = 'button'
        useButton.className = 'secondary-btn'
        useButton.textContent = tr('Use','使用')
        useButton.addEventListener('click', () => {
          stopEditing()
          createdCounter = item.counter
          $('source').value = item.counter
          $('label').value = config.label || ''
          $('style').value = config.style || 'flat'
          $('labelStyle').value = config.labelStyle || 'default'
          setPickerColor('labelColor', config.labelColor || '#A4D3EE')
          setPickerColor('countColor', config.countColor || '#555555')
          updateOutputs(item.counter, { daily: item.daily || 0, total: item.total || 0 })
        })
        const editButton = document.createElement('button')
        editButton.type = 'button'
        editButton.className = 'secondary-btn'
        editButton.textContent = tr('Edit','编辑')
        editButton.addEventListener('click', () => {
          editingCounter = item.counter
          createdCounter = item.counter
          $('source').value = item.counter
          $('label').value = config.label || ''
          $('style').value = config.style || 'flat'
          $('labelStyle').value = config.labelStyle || 'default'
          setPickerColor('labelColor', config.labelColor || '#A4D3EE')
          setPickerColor('countColor', config.countColor || '#555555')
          $('editNotice').hidden = false
          $('create').hidden = true
          $('saveCounter').hidden = false
          $('cancelEdit').hidden = false
          updateOutputs(item.counter, { daily: item.daily || 0, total: item.total || 0 })
          $('source').focus()
          $('source').scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
        const deleteButton = document.createElement('button')
        deleteButton.type = 'button'
        deleteButton.className = 'danger-btn'
        deleteButton.textContent = tr('Delete','删除')
        deleteButton.addEventListener('click', async () => {
          await deleteCounters([item.counter])
        })
        row.append(checkbox, info, useButton, editButton, deleteButton)
        list.appendChild(row)
      }
    }
    function stopEditing() {
      editingCounter = ''
      $('editNotice').hidden = true
      $('create').hidden = false
      $('saveCounter').hidden = true
      $('cancelEdit').hidden = true
    }
    function badgeFields() {
      return {
        label: $('label').value.trim(),
        labelColor: $('labelColor').value,
        countColor: $('countColor').value,
        style: $('style').value,
        labelStyle: $('labelStyle').value
      }
    }
    $('cancelEdit').addEventListener('click', () => {
      stopEditing()
      createdCounter = ''
      $('source').value = ''
      clearOutputs()
      showToast(tr('Edit cancelled','已取消编辑'))
    })
    $('saveCounter').addEventListener('click', async () => {
      const previous = editingCounter
      const next = counterValue()
      const authCode = $('authCode').value.trim()
      if (!previous || !next || !authCode) {
        alert(tr('A valid URL and Auth Code are required','需要有效地址与管理密码'))
        return
      }
      const renamed = next !== previous
      if (renamed && !confirm(tr('Move to the new URL? Visits and old key links will be preserved.','确定迁移到新 URL？访问记录及旧 Key 链接将保留。'))) return
      const save = $('saveCounter')
      save.disabled = true
      try {
        const payload = renamed
          ? { counter: previous, newCounter: next, authCode, config: badgeFields() }
          : { counter: previous, authCode, ...badgeFields() }
        const res = await fetch(renamed ? '/api/rename' : '/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Save failed')
        stopEditing()
        createdCounter = next
        updateOutputs(next, { daily: data.daily || 0, total: data.total || 0 })
        await loadCounters()
        showToast(renamed ? 'URL migrated; old badge links still work' : 'Badge style saved')
      } catch (error) {
        alert(error.message || 'Could not save changes')
      } finally {
        save.disabled = false
      }
    })
    function selectedCounters() {
      return Array.from(document.querySelectorAll('.counter-select:checked')).map(input => input.value)
    }
    async function deleteCounters(counters) {
      if (!counters.length) {
        alert(tr('Select at least one counter','请至少选择一个计数器'))
        return
      }
      if (!confirm(tr('Delete selected counters and history permanently?','永久删除选中的计数器和历史数据？'))) return
      const authCode = $('authCode').value.trim()
      if (!authCode) {
        alert(tr('Auth Code is required','请输入管理密码'))
        return
      }
      for (const counter of counters) {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ counter, authCode })
        })
        const data = await res.json()
        if (!res.ok) {
          alert(data.error || 'Delete failed')
          return
        }
        if (createdCounter === counter) createdCounter = ''
      }
      await loadCounters()
    }
    async function loadCounters(options = {}) {
      const authCode = $('authCode').value.trim()
      if (!authCode) {
        alert(tr('Auth Code is required','请输入管理密码'))
        return
      }
      const res = await fetch('/api/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authCode })
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Load failed')
        return
      }
      renderCounterList(data.counters || [])
      $('workspaceContent').hidden = false
      if (options.notify) showToast(tr('Counters loaded','计数器已加载'))
      if (options.scroll) $('counterList').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    $('create').addEventListener('click', async () => {
      const counter = counterValue()
      const authCode = $('authCode').value.trim()
      if (!counter) {
        alert(tr('Counter URL is required','请输入计数器地址'))
        return
      }
      if (!authCode) {
        alert(tr('Auth Code is required','请输入管理密码'))
        return
      }
      const res = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counter, authCode, label: $('label').value.trim(), labelColor: $('labelColor').value, countColor: $('countColor').value, style: $('style').value, labelStyle: $('labelStyle').value })
      })
      const data = await res.json()
      if (!res.ok && !data.exists) {
        alert(data.error || 'Create failed')
        return
      }
      createdCounter = counter
      updateOutputs(counter, { daily: data.daily || 0, total: data.total || 0 })
      await loadCounters()
      showToast(data.exists ? 'Saved existing counter style' : 'Counter created')
    })
    $('loadCounters').addEventListener('click', () => loadCounters({ notify: true, scroll: false }))
    $('authCode').addEventListener('keydown', event => {
      if (event.key === 'Enter') loadCounters({ notify: true, scroll: false })
    })
    function setOutputMode(mode) {
      outputMode = mode
      $('savedMode').classList.toggle('active', mode === 'saved')
      $('customMode').classList.toggle('active', mode === 'custom')
      updateOutputs(counterValue())
    }
    $('savedMode').addEventListener('click', () => setOutputMode('saved'))
    $('customMode').addEventListener('click', () => setOutputMode('custom'))
    $('selectAllCounters').addEventListener('click', () => {
      const boxes = Array.from(document.querySelectorAll('.counter-select'))
      const shouldSelect = boxes.some(box => !box.checked)
      for (const box of boxes) box.checked = shouldSelect
    })
    $('deleteSelectedCounters').addEventListener('click', async () => deleteCounters(selectedCounters()))
    for (const id of ['source', 'label', 'style', 'labelStyle']) {
      $(id).addEventListener('input', () => updateOutputs(counterValue()))
      $(id).addEventListener('change', () => updateOutputs(counterValue()))
    }
    setupColorPicker('labelColor')
    setupColorPicker('countColor')
    document.addEventListener('click', event => {
      if (!event.target.closest('.color-field')) {
        for (const panel of document.querySelectorAll('.color-popover.open')) panel.classList.remove('open')
      }
    })
    async function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        return
      }
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.focus()
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const output = $(button.dataset.copy)
        const code = output.textContent
        if (!code || output.classList.contains('empty')) return
        await copyText(code)
        const old = button.textContent
        button.textContent = tr('Copied','已复制')
        setTimeout(() => { button.textContent = old }, 900)
      })
    }
    $('source').addEventListener('input', () => {
      if (counterValue() !== createdCounter) {
        clearOutputs(editingCounter ? 'Save changes to generate the new URL.' : 'Create or select a counter first.')
      }
    })
  </script>
</body>
</html>`
}
function getParam(url, ...names) {
  for (const name of names) {
    const value = url.searchParams.get(name)
    if (value !== null && value !== '') return value
  }
  return ''
}


function renderDashboardChart(series, limit) {
  const data = series.slice(-Math.max(1,limit))
  const width=1020,height=360,left=56,right=20,top=20,bottom=55
  const innerWidth=width-left-right,innerHeight=height-top-bottom
  const peak=Math.max(1,...data.map(item=>Number(item.count)||0))
  const topTick=Math.max(4,Math.ceil(peak/4)*4)
  const coords=data.map((item,i)=>({
    x:left+(data.length===1?innerWidth/2:i*innerWidth/(data.length-1)),
    y:top+innerHeight-(Math.max(0,Number(item.count)||0)/topTick)*innerHeight,
    date:String(item.date),
    count:Number(item.count)||0
  }))
  const line=coords.map((point,i)=>(i?'L':'M')+point.x.toFixed(2)+' '+point.y.toFixed(2)).join(' ')
  const area=line+' L '+(coords.length?coords[coords.length-1].x:left)+' '+(top+innerHeight)+' L '+(coords.length?coords[0].x:left)+' '+(top+innerHeight)+' Z'
  const grid=Array.from({length:5},(_,i)=>{
    const y=top+innerHeight-i*innerHeight/4
    return '<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'" stroke="#e7edf7" stroke-dasharray="'+(i?'4 6':'0')+'"/>'+
      '<text x="'+(left-13)+'" y="'+(y+4)+'" text-anchor="end" font-size="12" fill="#98a6bb">'+Math.round(i*topTick/4)+'</text>'
  }).join('')
  const every=Math.max(1,Math.ceil(coords.length/7))
  const labels=coords.filter((p,i)=>i%every===0||i===coords.length-1).map(p=>
    '<text x="'+p.x+'" y="'+(height-19)+'" text-anchor="middle" font-size="12" fill="#93a1b5">'+escapeXml(p.date.slice(5))+'</text>'
  ).join('')
  const dots=coords.map(p=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="4" fill="#fff" stroke="#3273ec" stroke-width="2"><title>'+escapeXml(p.date+': '+p.count)+'</title></circle>').join('')
  const id='trendGradient'+limit
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="Daily visit counts over ${limit} available days" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4b86f2" stop-opacity=".24"/><stop offset="100%" stop-color="#4b86f2" stop-opacity=".012"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="#3273ec" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/>${dots}${labels}</svg>`
}
function renderStatusPage({ counter='', total=0, daily=0, series=[], error='', lang='en' }) {
  const t=(en,zh)=>lang==='zh'?zh:en
  const target=escapeXml(counter || '')
  const historyDays=getHistoryDays()
  const counts=series.map(item=>Math.max(0,Number(item.count)||0))
  const lastWeek=counts.slice(-7),week=lastWeek.reduce((a,b)=>a+b,0)
  const peak=counts.length?Math.max(...counts):0
  const avg=counts.length?(counts.reduce((a,b)=>a+b,0)/counts.length):0
  const first=series.length?escapeXml(String(series[0].date)):'—'
  const last=series.length?escapeXml(String(series[series.length-1].date)):'—'
  const updated=new Date().toISOString().replace('T',' ').slice(0,19)+' UTC'
  const number=value=>Number(value).toLocaleString('en-US')
  const report=!error
  return `<!doctype html><html lang="${lang==='zh'?'zh-CN':'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex"><title>${t('Analytics overview','访问统计概览')} · Cloudflare D1 Visit Counter</title><link rel="icon" href="${FAVICON_HREF}">
    <style>${UI_CSS}
    .report-hero{padding:36px 38px;background:linear-gradient(125deg,#1e4186,#3374e9);color:white;border-radius:21px;display:flex;align-items:center;justify-content:space-between;gap:25px}
    .report-hero .eyebrow{color:#b7d1ff}.report-hero h1{font-size:clamp(28px,3.6vw,41px);letter-spacing:-.045em;margin:12px 0}.report-hero .report-sub{font-size:13px;color:#cadcff;line-height:1.7}
    .target{margin-top:14px;background:#ffffff14;border:1px solid #ffffff2f;border-radius:10px;color:#e4edff;max-width:760px;padding:11px 14px;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    .live-pill{font-size:11px;white-space:nowrap;background:#ffffff1b;border:1px solid #ffffff38;border-radius:30px;padding:10px 14px;color:#f1f7ff}
    .report-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;margin:22px 0}
    .report-card{padding:25px}.report-card .label{font-size:12px;color:#8493a7;font-weight:650}.report-card .value{font-size:clamp(27px,3vw,39px);color:#1c3155;font-weight:820;letter-spacing:-.055em;margin:12px 0 6px}
    .report-card .hint{font-size:11px;color:#a0acbd}
    .report-card.emphasis{background:#edf4ff;border-color:#cbddff}.report-card.emphasis .value{color:#2865dc}
    .chart-card{padding:27px 30px}.chart-head{display:flex;justify-content:space-between;align-items:start;gap:18px;flex-wrap:wrap;margin-bottom:20px}
    .chart-head h2{margin:0;font-size:20px;letter-spacing:-.025em}.chart-head p{color:#8c9aaf;font-size:12px;margin:8px 0 0;line-height:1.65}
    .range-toggle{display:flex;gap:4px;border:1px solid #dfe6f2;background:#f4f7fc;padding:4px;border-radius:11px}
    .range-toggle button{cursor:pointer;padding:9px 14px;border:0;border-radius:8px;background:transparent;color:#7b899f;font-size:12px;font-weight:750}
    .range-toggle button[aria-pressed=true]{color:#2f67da;background:white;box-shadow:0 1px 6px #253e6c19}
    .chart-svg{min-height:210px}.chart-svg svg{display:block;width:100%;max-width:100%}
    .report-lower{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px;margin-top:20px}
    .small-card{padding:21px 24px}.small-card span{display:block;color:#8a99ad;font-size:12px}.small-card strong{display:block;font-size:21px;color:#274166;margin-top:9px;letter-spacing:-.025em}
    .report-fineprint{padding:15px 0 2px;font-size:12px;color:#94a1b5;line-height:1.8}
    .error-page{padding:45px;margin-top:30px}.error-page h1{margin-top:0}.error-page p{color:#7b889d}
    @media(max-width:950px){.report-stats{grid-template-columns:repeat(2,1fr)}.report-lower{grid-template-columns:1fr}}
    @media(max-width:600px){.report-hero{padding:28px 23px;flex-direction:column;align-items:start}.report-stats{gap:10px}.report-card{padding:18px}.chart-card{padding:20px 14px}.report-card .value{font-size:28px}}
    </style></head><body>
    ${uiHeader(new URL('https://'+ALLOWED_DOMAIN+'/status?path='+encodeURIComponent(counter)+'&lang='+lang),lang,'')}
    <main class="shell">
    ${!report ? `<section class="surface error-page"><div class="eyebrow">${t('STATISTICS','访问统计')}</div><h1>${t('Unable to load this counter','无法加载计数器')}</h1><p>${escapeXml(error)}</p><a class="btn-outline" href="/?lang=${lang}">${t('Back to overview','返回首页')} ←</a></section>` :
     `<section class="report-hero"><div><div class="eyebrow">${t('PUBLIC ANALYTICS','公开统计面板')}</div><h1>${t('Analytics overview','访问统计概览')}</h1>
     <div class="report-sub">${t('Visit request statistics for the selected counter.','当前计数器的访问请求统计数据。')}</div><div class="target">${target}</div></div><div class="live-pill">● ${t('Public report','公开统计报告')}</div></section>
     <section class="report-stats" aria-label="${t('Key metrics','核心指标')}">
       <article class="surface report-card emphasis"><div class="label">${t('Total visits','累计访问量')}</div><div class="value">${number(total)}</div><div class="hint">${t('Since counter creation','从创建计数器开始累计')}</div></article>
       <article class="surface report-card"><div class="label">${t('Today','今日访问')}</div><div class="value">${number(daily)}</div><div class="hint">${t('UTC calendar day','按 UTC 自然日统计')}</div></article>
       <article class="surface report-card"><div class="label">${t('Last 7 days','近七日访问')}</div><div class="value">${number(week)}</div><div class="hint">${t('Available retained records','基于保留的历史记录')}</div></article>
       <article class="surface report-card"><div class="label">${t('Daily average','日均访问')}</div><div class="value">${number(Math.round(avg))}</div><div class="hint">${t('Across displayed history','按当前可用历史记录计算')}</div></article>
     </section>
     <section class="surface chart-card"><div class="chart-head"><div><h2>${t('Visitor trend','访问量趋势')}</h2><p>${t('Daily counts · Hover chart points for exact values.','按日统计 · 鼠标悬停数据点可查看数值。')}</p></div><div class="range-toggle" role="group" aria-label="${t('Chart time range','趋势时间范围')}"><button type="button" data-range="7" aria-pressed="false">${t('7 days','7 天')}</button><button type="button" data-range="all" aria-pressed="true">${t('Available history','全部历史')}</button></div></div>
     <div class="chart-svg" id="chartAll">${renderDashboardChart(series,historyDays)}</div>
     <div class="chart-svg" id="chart7" hidden>${renderDashboardChart(series,7)}</div></section>
     <section class="report-lower"><div class="surface small-card"><span>${t('Highest daily visits','单日最高访问')}</span><strong>${number(peak)}</strong></div><div class="surface small-card"><span>${t('Available date range','历史数据区间')}</span><strong style="font-size:15px">${first} — ${last}</strong></div><div class="surface small-card"><span>${t('Data retention','历史数据保留')}</span><strong>${historyDays} ${t('days','天')}</strong></div></section>
     <div class="report-fineprint">${t('Statistics reflect badge and counter requests, not unique visitors. Daily history is retained for up to','访问量表示徽章或计数接口请求次数，并非独立访客人数。历史明细最多保留')} ${historyDays} ${t('days. Generated','天。页面生成时间：')} ${updated}.</div>`}
    </main><footer class="site-footer">Cloudflare D1 Visit Counter · <a target="_blank" rel="noopener noreferrer" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter">Open source on GitHub ↗</a></footer>
    <script>for(const b of document.querySelectorAll('[data-range]')) b.addEventListener('click',()=>{const week=b.dataset.range==='7';document.getElementById('chart7').hidden=!week;document.getElementById('chartAll').hidden=week;for(const x of document.querySelectorAll('[data-range]'))x.setAttribute('aria-pressed',String(x===b))})</script></body></html>`
}
function isCounterAllowed(counter) {
  return ALLOWED_PATHS.length === 0 || ALLOWED_PATHS.includes(counter)
}

function normalizeBadgeConfig(value = {}) {
  return {
    label: normalizeBadgeLabel(value.label),
    labelColor: normalizeStoredHex(value.labelColor, '#A4D3EE'),
    countColor: normalizeStoredHex(value.countColor, '#555555'),
    style: normalizeBadgeStyle(value.style || 'flat', false),
    labelStyle: normalizeLabelStyle(value.labelStyle || 'default'),
  }
}

function normalizeStoredHex(value, fallback) {
  const raw = String(value || '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase()
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return ('#' + raw).toUpperCase()
  return fallback
}

function normalizeBadgeLabel(value) {
  return String(value || '').trim().slice(0, 80)
}

function normalizeCounterName(value) {
  const counter = String(value || '').trim()
  if (!counter || counter.length > 512) return ''
  if (/[\x00-\x1F\x7F]/.test(counter)) return ''
  return counter
}

function resolveColor(value) {
  const color = String(value || '').trim().toLowerCase()
  if (namedColors[color]) return namedColors[color]
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return color
  if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return `#${color}`
  return '#97ca00'
}

function getTextWidth(text) {
  let width = 10
  for (const char of text) {
    width += char.charCodeAt(0) > 255 ? 14 : 7
  }
  return Math.max(width, 28)
}

function recentDates(days) {
  const dates = []
  for (let offset = days - 1; offset >= 0; offset--) {
    dates.push(offsetDateString(-offset))
  }
  return dates
}

function getHistoryDays() {
  const days = Number.parseInt(HISTORY_DAYS, 10)
  if (!Number.isFinite(days)) return 30
  return Math.max(1, days)
}

function dateRange(firstDate, lastDate) {
  const dates = []
  const cursor = new Date(`${firstDate}T00:00:00.000Z`)
  const end = new Date(`${lastDate}T00:00:00.000Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}
function todayString() {
  return offsetDateString(0)
}

function offsetDateString(offset) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function round(value) {
  return Math.round(value * 100) / 100
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function svgResponse(svg, cacheControl = 'no-cache, no-store, must-revalidate, max-age=0') {
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': cacheControl,
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  })
}

function textResponse(text, status) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}


