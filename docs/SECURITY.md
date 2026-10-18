# Security and Privacy

## Auth Code Boundary

`AUTH_CODE` protects management actions only:

- create counter
- list counters
- rename counter URL / key and edit saved badge style
- delete counter

Public badge and status URLs do not require `AUTH_CODE`, because they are designed to be embedded in README files, websites, and docs.

## Public Counter Boundary

A public badge URL can increment an existing counter. It cannot create a new counter automatically.

If a counter key should not be public, do not publish its badge URL or status URL. Anyone who knows the counter key can open the status page.

## Privacy

The Worker does not store:

- IP address
- User-Agent
- Referer
- Cookie
- visitor identity

It only stores counter totals, daily totals, and badge configuration. Total counters are retained permanently until deletion. Daily trend rows are retained for the latest `HISTORY_DAYS` days only.

## Hardening Options

- Use a long, non-default `AUTH_CODE`.
- Do not publish `AUTH_CODE` in README, frontend code, issues, or examples.
- Fill `ALLOWED_PATHS` if you want to restrict service to fixed counter keys.
- Add Cloudflare WAF / rate limiting if you expose badges to very high traffic.
- Consider Turnstile for dashboard access if you later add a login layer.


## Public Showcase Is Not Hosted Counter Access

The public homepage shows a static, client-side badge style example with illustrative values and points visitors to the GitHub deployment guide. It does not give visitors access to the owner's D1 database for creating new counters. An `AUTH_CODE` configured by each deployer is required for all management actions, including migrations. Public badge URLs are intentionally embeddable and **do** increment existing counters, so normal traffic to published counters still uses the owner's Worker and D1 resources.

Renames are performed in an atomic D1 batch, retain existing statistics, and reject key collisions. Retired keys forward only to the canonical key and are reserved until deletion, so they cannot silently begin counting an unrelated new project. Worker's original hostname must remain reachable (or be updated in embeds) after a hostname migration; counter-key aliasing alone does not redirect hostnames.
