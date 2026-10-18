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

  if (url.pathname === '/' || url.pathname === '') {
    return htmlResponse(renderGeneratorPage())
  }

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
    return handleStatusPage(url, db)
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

async function handleStatusPage(url, db) {
  const counter = normalizeCounterName(url.searchParams.get('counter') || url.searchParams.get('path'))
  if (!counter) {
    return htmlResponse(renderStatusPage({ error: 'Missing or invalid path' }))
  }

  const canonical = await resolveCounterForRead(db, counter)
  if (!canonical) return htmlResponse(renderStatusPage({ counter, error: 'Counter not found' }))
  counter = canonical
  const today = todayString()
  const total = await getCounterValue(db, `${counter}:total`)
  const daily = await getCounter(db, `${counter}:daily:${today}`)
  const historyDays = getHistoryDays()
  const days = clampInt(url.searchParams.get('days'), historyDays, 1, historyDays)
  const series = await getDailySeries(db, counter, days)
  return htmlResponse(renderStatusPage({ counter, total, daily, series }))
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
  const counter = normalizeCounterName(url.searchParams.get('counter') || url.searchParams.get('path'))
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
function renderGeneratorPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visit Counter</title>
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
  </style>
</head>
<body>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <main>
    <header class="site-head">
      <div class="site-brand">${PROJECT_LOGO_SVG}<div>Cloudflare D1 Visit Counter<small>Open-source · Self-hosted visitor badges</small></div></div>
      <a class="site-link" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>
    </header>
    <section class="landing" aria-labelledby="introTitle">
      <div>
        <span class="eyebrow"><span class="dot" aria-hidden="true"></span> Open source · Bring your own Cloudflare</span>
        <h1 id="introTitle">Visitor badges.<br><span>Your infrastructure.</span></h1>
        <p class="lead">Create your own GitHub README and website visit counters, with customizable SVG badges, a history dashboard, and statistics stored in your Cloudflare D1 database.</p>
        <div class="cta-row">
          <a class="cta cta-primary" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter#快速部署" target="_blank" rel="noopener noreferrer">Deploy your own instance ↗</a>
          <a class="cta cta-secondary" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter" target="_blank" rel="noopener noreferrer">Explore source code</a>
        </div>
        <div class="usage-note" role="note">
          <strong>This is a showcase, not a free badge-hosting service.</strong>
          This page is a public preview of a privately operated Worker. Visitors cannot create counters, generate working badge links, or use the owner's D1 storage here. To issue real badges, deploy the open-source project in your own Cloudflare account and set your own Auth Code.<span lang="zh-CN" style="display:block;margin-top:7px;">本站仅用于开源项目展示，不提供免费徽章生成或后台托管服务。请在自己的 Cloudflare 账号中部署后使用。</span>
        </div>
      </div>
      <aside class="sample-card" aria-label="Illustrative badge design demo">
        <div class="sample-label">STYLE EXAMPLE · STATIC DEMO</div>
        <div class="sample-stage"><div class="sample-badge" id="sampleBadge"><span>Visitors</span><strong>24 / 1,280</strong></div></div>
        <div class="demo-controls" role="group" aria-label="Try sample badge color">
          <button type="button" data-demo-theme="blue" aria-pressed="true">Blue</button>
          <button type="button" data-demo-theme="green" aria-pressed="false">Green</button>
          <button type="button" data-demo-theme="purple" aria-pressed="false">Purple</button>
        </div>
        <p class="demo-caption">Illustrative values only. This interactive style sample makes no API calls, saves no data, and does not create a usable visit counter.</p>
      </aside>
    </section>
    <section class="steps" id="get-started" aria-labelledby="stepsTitle">
      <h2 class="section-head" id="stepsTitle">Your own counter in three steps</h2>
      <div class="step-grid">
        <div class="step"><span class="step-num">01</span><h3>Get the code</h3><p>Open the <a href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter" target="_blank" rel="noopener noreferrer">GitHub repository</a> and copy <code>worker.js</code>.</p></div>
        <div class="step"><span class="step-num">02</span><h3>Create a D1 database</h3><p>Initialize the counters table in your Cloudflare account and bind it as <code>HITS</code>.</p></div>
        <div class="step"><span class="step-num">03</span><h3>Deploy &amp; generate</h3><p>Set <code>ALLOWED_DOMAIN</code> and <code>AUTH_CODE</code>, deploy your Worker, then create badges on your own URL.</p></div>
      </div>
    </section>
    <details id="ownerDashboard" class="workspace-details">
      <summary>Private management workspace <small>For the owner of this deployment only. Auth Code required for creating, editing, listing and deleting counters.</small></summary>
      <p class="owner-hint">This dashboard manages only the counters stored in the connected D1 database. Public visitors should deploy their own instance instead.</p>
    <section class="panel">
      <div class="grid">
        <label style="grid-column: 1 / -1;">Auth Code<input id="authCode" type="password" placeholder="Deploy your own Worker and configure AUTH_CODE in worker.js to unlock all features"></label>
        <label><span class="field-title"><span>URL</span><span class="field-note">Custom public key is also supported</span></span><input id="source"></label>
        <label><span class="field-title"><span>Badge Label</span><span class="field-note"></span></span><input id="label"></label>
        <div class="color-row">
        <div class="color-field" data-color-field="labelColor">
          <span>Label Background</span>
          <button class="color-button" type="button" id="labelColorButton">Click to change</button>
          <div class="color-popover" id="labelColorPanel">
            <div class="color-large" id="labelColorLarge">#A4D3EE</div>
            <div class="palette" id="labelColorPalette"></div>
            <input class="hex-input" id="labelColor" value="#A4D3EE">
          </div>
        </div>
        <div class="color-field" data-color-field="countColor">
          <span>Count Background</span>
          <button class="color-button" type="button" id="countColorButton">Click to change</button>
          <div class="color-popover" id="countColorPanel">
            <div class="color-large" id="countColorLarge">#555555</div>
            <div class="palette" id="countColorPalette"></div>
            <input class="hex-input" id="countColor" value="#555555">
          </div>
        </div>
        </div>
        <label>Badge Style
          <select id="style">
            <option value="flat">flat</option>
            <option value="flat-square">flat-square</option>
            <option value="plastic">plastic</option>
            <option value="for-the-badge">for-the-badge</option>
            <option value="social">social</option>
          </select>
        </label>
        <label>Badge Type
          <select id="labelStyle">
            <option value="default">today / total</option>
            <option value="none">total only</option>
          </select>
        </label>
      </div>
      <p class="hint">URL is the saved counter key; Badge Label changes only the visible text. To move an existing counter and keep its visits, choose Edit below.</p>
      <p class="edit-banner" id="editNotice" hidden aria-live="polite">Editing an existing counter. Change the URL to migrate its total visits, history and badge style; old badge links will keep working.</p>
      <div class="actions">
        <button id="create">Create Counter</button><button id="saveCounter" type="button" hidden>Save Changes</button><button id="cancelEdit" type="button" class="secondary-btn" hidden>Cancel Edit</button><button id="loadCounters" class="secondary-btn" type="button">Load Created Counters</button>
        <div class="preview"><img id="badgePreview" alt=""><a id="statusLink" href="#" target="_blank" rel="noopener noreferrer" style="display:none; margin-left:12px; color:#0969da; font-weight:700;">Open status page</a></div>
      </div>
    </section>
    <section class="panel">
      <div class="mode-row"><span class="mode-label">Output style</span><div class="segmented"><button id="savedMode" class="active" type="button">Saved style</button><button id="customMode" type="button">Custom URL</button></div></div>
      <p>Markdown (badge only)</p><div class="output-row"><code id="markdownCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="markdownCode">Copy</button></div>
      <p>Markdown (with status)</p><div class="output-row"><code id="markdownLinkCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="markdownLinkCode">Copy</button></div>
      <p>HTML (with status)</p><div class="output-row"><code id="htmlCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="htmlCode">Copy</button></div>
      <p>Image URL (badge only)</p><div class="output-row"><code id="imageUrlCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="imageUrlCode">Copy</button></div><p>Status page (status only)</p><div class="output-row"><code id="statusUrlCode" class="empty">Create a counter first.</code><button class="copy-btn" data-copy="statusUrlCode">Copy</button></div>
    </section>
    <section class="panel">
      <h2>Created Counters</h2>
      <p class="hint">Select Use to copy an existing link, or Edit to update its URL and style without resetting statistics. Delete permanently removes its data. All actions require the owner's Auth Code.</p>
      <div class="counter-toolbar"><button id="selectAllCounters" class="secondary-btn" type="button">Select All</button><button id="deleteSelectedCounters" class="danger-btn" type="button">Delete Selected</button></div>
      <div id="counterList" class="counter-list"><span class="empty">No counters loaded.</span></div>
    </section>
    </details>
    <footer class="footer">Open-source software · Bring your own Cloudflare Workers + D1 · <a href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter" target="_blank" rel="noopener noreferrer">GitHub source &amp; deployment guide ↗</a></footer>
  </main>
  <script>
    const domain = location.host
    const $ = id => document.getElementById(id)
    let createdCounter = ''
    let currentCounts = { daily: 0, total: 0 }
    let outputMode = 'saved'
    let editingCounter = ''
    for (const button of document.querySelectorAll('[data-demo-theme]')) {
      button.addEventListener('click', () => {
        $('sampleBadge').className = 'sample-badge' + (button.dataset.demoTheme === 'blue' ? '' : ' ' + button.dataset.demoTheme)
        for (const other of document.querySelectorAll('[data-demo-theme]')) other.setAttribute('aria-pressed', String(button === other))
      })
    }
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
        list.innerHTML = '<span class="empty">No counters created yet.</span>'
        return
      }
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
        total.textContent = 'Total visits: ' + item.total
        info.append(name, badge, total)
        const useButton = document.createElement('button')
        useButton.type = 'button'
        useButton.className = 'secondary-btn'
        useButton.textContent = 'Use'
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
        editButton.textContent = 'Edit'
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
        deleteButton.textContent = 'Delete'
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
      showToast('Edit cancelled')
    })
    $('saveCounter').addEventListener('click', async () => {
      const previous = editingCounter
      const next = counterValue()
      const authCode = $('authCode').value.trim()
      if (!previous || !next || !authCode) {
        alert('A valid URL and Auth Code are required')
        return
      }
      const renamed = next !== previous
      if (renamed && !confirm('Move this counter to the new URL? Existing visits and old badge links will be preserved.')) return
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
        alert('Select at least one counter')
        return
      }
      if (!confirm('Delete selected counter data and status charts?')) return
      const authCode = $('authCode').value.trim()
      if (!authCode) {
        alert('Auth code is required')
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
        alert('Auth code is required')
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
      if (options.notify) showToast('Created counters loaded')
      if (options.scroll) $('counterList').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    $('create').addEventListener('click', async () => {
      const counter = counterValue()
      const authCode = $('authCode').value.trim()
      if (!counter) {
        alert('URL is required')
        return
      }
      if (!authCode) {
        alert('Auth code is required')
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
    $('loadCounters').addEventListener('click', () => loadCounters({ notify: true, scroll: true }))
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
        button.textContent = 'Copied'
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

function renderStatusPage({ counter = '', total = 0, daily = 0, series = [], error = '' }) {
  const safeCounter = escapeXml(counter || 'status')
  const historyDays = getHistoryDays()
  const counts = series.map(item => item.count)
  const highest = counts.length ? Math.max(...counts) : 0
  const lowest = counts.length ? Math.min(...counts) : 0
  const rangeTotal = counts.reduce((sum, count) => sum + count, 0)
  const averageText = String(Math.round(counts.length ? rangeTotal / counts.length : 0))
  const chart = error ? '' : generateHistorySvg({
    title: 'Visit Trend',
    series,
    width: 980,
    height: 430,
    chartType: 'area',
    color: '#A4D3EE',
  })
  const updatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeCounter} status</title>
  <link rel="icon" type="image/svg+xml" href="${FAVICON_HREF}">
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f8fa; color: #24292f; }
    main { max-width: 1080px; margin: 0 auto; padding: 42px 18px 44px; }
    .topline { text-align: center; margin-bottom: 26px; }
    .status-title-row { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
    .project-logo { width: 48px; height: 48px; flex: 0 0 auto; display: block; }
    .project-line { margin-top: 12px; color: #57606a; font-size: 14px; }
    .project-line strong { color: #24292f; }
    .project-line a { color: #0969da; font-weight: 750; text-decoration: none; }
    .project-line a:hover { text-decoration: underline; }
    h1 { margin: 0; font-size: clamp(30px, 5vw, 46px); letter-spacing: 0; }
    .overview { margin: 10px 0 0; color: #57606a; font-size: 16px; overflow-wrap: anywhere; }
    .center { text-align: center; }
    .eyebrow { color: #57606a; font-weight: 750; }
    h2 { margin: 10px 0 8px; font-size: clamp(28px, 5vw, 42px); }
    .sub { margin: 0; color: #6e7781; font-size: 16px; }
    .panel { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 22px; margin-top: 20px; box-shadow: 0 8px 24px rgba(31, 35, 40, .06); }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
    .stat { background: linear-gradient(180deg, #ffffff, #f6f8fa); border: 1px solid #d0d7de; border-radius: 8px; padding: 18px; }
    .value { font-size: 36px; font-weight: 850; line-height: 1; }
    .label { margin-top: 8px; color: #57606a; font-size: 13px; }
    .chart-wrap { overflow-x: auto; }
    .error { color: #b42318; font-weight: 700; }
    @media (max-width: 720px) { .stats { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    ${error ? `<section class="panel error">${escapeXml(error)}</section>` : `<section class="topline"><div class="status-title-row">${PROJECT_LOGO_SVG}<h1>Analytics Overview</h1></div><p class="overview">Overview for</p><div class="target-key">${safeCounter}</div><div class="project-line">Powered by <a class="project-link" href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter" target="_blank" rel="noopener noreferrer">Cloudflare-D1-Visit-Counter</a> · Author: <a class="project-link" href="https://github.com/FuTseYi" target="_blank" rel="noopener noreferrer">FuTseYi</a></div></section><section class="center"><p class="sub">Statistics for available daily data, up to ${historyDays} days · Last generated: ${updatedAt}</p></section><section class="panel stats"><div class="stat"><div class="value">${daily}</div><div class="label">Today</div></div><div class="stat"><div class="value">${total}</div><div class="label">Total visits</div></div><div class="stat"><div class="value">${series.length}</div><div class="label">Days in chart</div></div><div class="stat"><div class="value">${highest}</div><div class="label">Highest daily</div></div><div class="stat"><div class="value">${lowest}</div><div class="label">Lowest daily</div></div><div class="stat"><div class="value">${averageText}</div><div class="label">Average daily</div></div></section><section class="panel"><div class="chart-wrap">${chart}</div></section>`}
  </main>
</body>
</html>`
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


