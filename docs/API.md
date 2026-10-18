# API Reference

This document describes the public and management APIs for `Cloudflare-D1-Visit-Counter`.

## Public Badge

```url
GET /api/combined?path={counterKey}
```

Returns an SVG badge and increments an existing counter. By default, badge style is loaded from the saved counter config in D1, so embedded badge links stay stable after you edit the style in the dashboard. The dashboard's `Saved style` mode outputs this short URL.

Optional URL parameters can override the saved style for one embed. The dashboard's `Custom URL` mode outputs this full URL:

```url
GET /api/combined?path={counterKey}&label={badgeLabel}&labelColor=%23A4D3EE&countColor=%23555555&style=flat&labelStyle=default
```

| Parameter | Alias | Description |
| --- | --- | --- |
| `path` | `counter` | Counter key. Required. |
| `label` | `title` | Optional badge label override. |
| `labelColor` | `title_bg` | Optional label background override. Hex or Shields-style named color. |
| `countColor` | `count_bg` | Optional count background override. Hex or Shields-style named color. |
| `style` | - | Optional style override: `flat`, `flat-square`, `plastic`, `for-the-badge`, `social`. |
| `labelStyle` | - | Optional type override: `default` for `today / total`, `none` for `total only`. |

## Status Page

```url
GET /status?path={counterKey}&days=30
```

Shows today, total visits, available daily statistics, and a trend chart. `days` is optional and is capped by `HISTORY_DAYS`.

## Management API

All management endpoints require `AUTH_CODE` and `Content-Type: application/json`.

### Create or Update Counter

```bash
curl -X POST https://your.domain.com/api/create \
  -H "Content-Type: application/json" \
  -d '{
    "counter": "https://example.com/",
    "authCode": "your-auth-code",
    "label": "Visitors",
    "labelColor": "#A4D3EE",
    "countColor": "#555555",
    "style": "flat",
    "labelStyle": "default"
  }'
```

### Rename a Counter (Preserving Statistics)

```bash
curl -X POST https://your.domain.com/api/rename \
  -H "Content-Type: application/json" \
  -d '{
    "counter": "https://old.example.com/",
    "newCounter": "https://new.example.com/",
    "authCode": "your-auth-code"
  }'
```

This endpoint atomically moves the counter's total, daily history, legacy label, cleanup metadata and saved badge configuration to the new key. You may optionally provide a `config` object with `label`, `labelColor`, `countColor`, `style` and `labelStyle` to save new visual settings as part of the same transaction.

- The original counter must exist. Both keys must pass `ALLOWED_PATHS` when configured.
- Renaming onto an existing counter or another counter's reserved alias returns HTTP `409`. No totals are overwritten.
- Previous keys remain reserved as forwarding aliases for existing badge, status, history, monthly and legacy endpoints. Aliases follow subsequent renames.
- You can rename back to your own previous key. Deleting the canonical counter also removes its aliases.
- Aliases preserve **counter keys only**. If you change your Worker's host / custom domain, update the domain in embedded badge URLs separately.

### List Counters

```bash
curl -X POST https://your.domain.com/api/list \
  -H "Content-Type: application/json" \
  -d '{"authCode":"your-auth-code"}'
```

### Delete Counter

```bash
curl -X POST https://your.domain.com/api/delete \
  -H "Content-Type: application/json" \
  -d '{"counter":"https://example.com/","authCode":"your-auth-code"}'
```

Deleting a counter removes its total count, daily chart data, and saved badge config.

## Compatibility Endpoints

```url
GET /api/monthly?counter={counterKey}
GET /{counterKey}.svg?action=hit
GET /{counterKey}?action=view
GET /history/{counterKey}.svg?days=30&chartType=bar
GET /chart/{counterKey}.svg?days=30&chartType=scatter
GET /history.svg?path={counterKey}&days=30&chartType=bar
GET /chart.svg?path={counterKey}&days=30&chartType=scatter
```

`/history` and `/chart` use `HISTORY_DAYS` as the default and maximum range. Use the query-style endpoints when the counter key is a full URL, repository path, or Chinese text. Total visits remain permanent; daily trend rows are retained only inside the configured history window.

Recommended new integrations should use `/api/combined` and `/status`, because they match the dashboard output.

`/api/monthly` is a read-only compatibility endpoint. It does not increment visits and returns total visits, today's visits, the current month's available daily sum, and retained daily rows for the current month.
