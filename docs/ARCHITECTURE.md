# Architecture

`Cloudflare-D1-Visit-Counter` is intentionally small: one Cloudflare Worker and one D1 table.

## Data Model

```sql
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);
```

| Key pattern | Meaning |
| --- | --- |
| `{counter}:total` | Total visits. |
| `{counter}:daily:{YYYY-MM-DD}` | Daily visits. |
| `{counter}:meta:config` | Saved badge label, colors, style, and type. |
| `{oldCounter}:meta:alias` | The canonical key after a rename; reserves the previous key for existing embeds. |

## Hot Path

For `/api/combined`, the Worker:

1. Validates the counter key.
2. Updates `{counter}:total` only if the counter already exists.
3. Updates `{counter}:daily:{YYYY-MM-DD}`.
4. Generates the SVG badge directly in the Worker response.

The public badge URL does not create counters automatically. This keeps the D1 database cleaner and reduces accidental write growth.

## Retention Policy

| Data | Retention |
| --- | --- |
| `{counter}:total` | Permanent until the counter is manually deleted. |
| `{counter}:daily:{YYYY-MM-DD}` | Last `HISTORY_DAYS` days only. Older daily rows are cleaned automatically. |
| `{counter}:meta:config` | Permanent until the counter is manually deleted. |
| `{counter}:meta:cleanup` | Internal cleanup marker, deleted with the counter. |

Daily cleanup runs at most once per counter per day for the current `HISTORY_DAYS` value. It keeps the total count untouched and only removes old daily trend rows.

Increasing `HISTORY_DAYS` keeps existing daily rows and lets the retained window grow from that point forward. Decreasing it removes rows outside the new window on the next cleanup. Already deleted daily rows cannot be rebuilt, but `{counter}:total` remains accurate.

## Cost Design

- No external runtime dependencies.
- No image storage.
- No static asset requests.
- Favicon uses an inline SVG data URL.
- One compact D1 table.
- Public badge hot path performs only the necessary D1 writes.
- Trend storage is bounded by `HISTORY_DAYS`; total storage is one permanent row per counter.

For high-traffic public badges, compare your expected traffic with current Cloudflare Workers and D1 limits before deployment.


## Counter URL Migration

Authenticated `POST /api/rename` changes the counter key without resetting counts. All rows belonging to the original key (`total`, daily `YYYY-MM-DD`, `meta:config`, legacy `meta:label`, and `meta:cleanup`) move inside one D1 `batch()` transaction. Updating existing aliases and adding the old-key alias happen in the same transaction; conflicts roll back the whole migration.

The hot path still tries the canonical total directly first. **Only when that lookup misses** does the public badge endpoint fetch a retired-key alias, keeping normal counter requests fast. Previous counter keys cannot be reused while aliased; deletion removes their aliases. Changing the Worker hostname is independent of renaming a D1 counter key.
