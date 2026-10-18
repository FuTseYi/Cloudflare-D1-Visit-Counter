# Cloudflare-D1-Visit-Counter

<p align="center">
  <img src="docs/images/logo.svg" width="72" alt="Cloudflare-D1-Visit-Counter logo" />
</p>

<p>
  <a href="https://github.com/FuTseYi/Cloudflare-D1-Visit-Counter"><img src="https://img.shields.io/badge/project-Cloudflare--D1--Visit--Counter-0969DA" alt="project" /></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/database-Cloudflare%20D1-5A67D8" alt="Cloudflare D1" />
  <img src="https://img.shields.io/badge/output-SVG%20Badge-2ECC71" alt="SVG Badge" />
  <img src="https://img.shields.io/badge/deploy-serverless-24292F" alt="serverless" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

<p align="center">
  <a href="https://visit-counter.futseyi.workers.dev/status?path=https%3A%2F%2Fgithub.com%2FFuTseYi%2FCloudflare-D1-Visit-Counter">
    <img src="https://visit-counter.futseyi.workers.dev/api/combined?path=https%3A%2F%2Fgithub.com%2FFuTseYi%2FCloudflare-D1-Visit-Counter" alt="Cloudflare-D1-Visit-Counter visitors" />
  </a>
</p>

[中文说明](README.md) | English

**Cloudflare-D1-Visit-Counter** is an open-source, self-hosted visitor counter and private badge generator powered by **Cloudflare Workers + Cloudflare D1**. It is not just another public visitor badge service. It runs inside your own Cloudflare account, uses your own domain and D1 database, and lets you create, maintain, and manage multiple counters with a single `AUTH_CODE`.

Deploy it once, then use it as a multi-purpose **GitHub README visitor badge**, website visitor counter, blog counter, documentation counter, and project page analytics badge. It generates SVG badges, Markdown / HTML / Image URL embeds, public status pages, and history charts while keeping the data under your control.

## Quick Start

- [Deploy in minutes🚀](#quick-start-deployment)
- [Create your first badge](#dashboard)
- [Copy Markdown / HTML / Image URL](#examples)
- [Read the API reference](docs/API.md)
- [Security and privacy](docs/SECURITY.md)

## Why this is different

Many visitor badge tools only solve one thing: showing a count. They often rely on a shared public domain, shared storage, or an external service you do not control. That is easy to start with, but harder to trust and maintain when you want counters for multiple README files, websites, blogs, docs, or project pages.

`Cloudflare-D1-Visit-Counter` gives you your own visitor counter generator. After one deployment, you can use one dashboard and one `AUTH_CODE` to create separate counters for different pages, preview badge styles, reuse saved links, delete old counters, and keep every counter under the same maintenance surface.

## Highlights

| Feature                       | Design                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Fully yours                   | Use your own Cloudflare Worker, D1 database, domain, and data table.                         |
| Deploy once, use everywhere   | One Worker can serve multiple README files, websites, blogs, docs, and project pages.        |
| Password-protected management | `AUTH_CODE` protects create, list, rename, and delete operations, so only you can maintain counters. |
| Abuse control                 | Public badge URLs cannot create counters automatically.                                      |
| Unified dashboard             | Create, preview, edit keys and styles, load, reuse, and delete counters for different pages in one place.          |
| Status page                   | Every counter gets a public status page and trend chart.                                     |
| Saved styles                  | Badge label, colors, style, and type are stored in D1.                                       |
| Flexible keys                 | Counter keys can be URLs, repository paths, page names, or Chinese text.                     |
| Low cost                      | One Worker, one D1 table, no external runtime dependencies.                                  |

## Quick Start Deployment

### 1. Create a D1 database

In the Cloudflare Dashboard, open **Storage & Databases -> D1 SQL Database**, then click **Create database**.

<p align="center">
  <img src="docs/images/deploy-01-create-d1-database.png" alt="Create a Cloudflare D1 database" width="860" />
</p>

Use `hits` as the database name, or use your own name. In the Worker binding step, select this same D1 database.

<p align="center">
  <img src="docs/images/deploy-02-create-d1-database-name.png" alt="Name the Cloudflare D1 database" width="860" />
</p>

After the database is created, run this SQL in D1 Console to initialize the table:

```sql
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);
```

<p align="center">
  <img src="docs/images/deploy-03-initialize-d1-table.png" alt="Initialize the D1 table in D1 Console" width="860" />
</p>

### 2. Open Workers & Pages

Go back to the Cloudflare Dashboard and open **Workers & Pages**. Create a Worker service first. You can enter the Worker details page with the default template, then bind D1 before pasting `worker.js`.

<p align="center">
  <img src="docs/images/deploy-04-open-workers-pages.png" alt="Open Cloudflare Workers and Pages" width="860" />
</p>

### 3. Bind D1 first

In the Worker settings, open **Settings -> Bindings**, then click **Add binding**.

<p align="center">
  <img src="docs/images/deploy-05-add-binding.png" alt="Add a Worker binding" width="860" />
</p>

Choose **D1 database** as the binding type.

<p align="center">
  <img src="docs/images/deploy-06-add-d1-binding.png" alt="Choose D1 database binding" width="860" />
</p>

Use this binding configuration:

| Binding name | Value            |
| ------------ | ---------------- |
| `HITS`       | Your D1 database |

The binding name must stay `HITS`, because `worker.js` reads the database from `env.HITS`. For the D1 database value, select the database created in step 1, such as `hits`.

<p align="center">
  <img src="docs/images/deploy-07-configure-d1-binding.png" alt="Configure the D1 binding name and database" width="860" />
</p>

### 4. Create and edit Worker code

Open the Worker code editor and paste the full content of this repository's `worker.js`.

<p align="center">
  <img src="docs/images/deploy-08-edit-worker-code.png" alt="Open the Worker code editor" width="860" />
</p>

Configure the top of `worker.js`:

```js
const ALLOWED_DOMAIN = 'your.domain.com'
const AUTH_CODE = 'change-this-auth-code'
const ALLOWED_PATHS = []
const HISTORY_DAYS = 30
```

`ALLOWED_PATHS = []` allows all created counters. Once you add values, only those counter keys are accepted.

After editing, click **Deploy** to publish the Worker.

<p align="center">
  <img src="docs/images/deploy-09-deploy-worker.png" alt="Deploy the Cloudflare Worker" width="860" />
</p>

### 5. Use workers.dev or a custom domain

A custom domain is optional: you can use the permanent `*.workers.dev` hostname supplied by Cloudflare, such as `visit-counter.example.workers.dev`, without purchasing a domain. You can also bind your own custom domain. In either case, set `ALLOWED_DOMAIN` to the exact hostname serving the Worker.

<p align="center">
  <img src="docs/images/deploy-10-add-custom-domain.png" alt="Add a custom domain for the Worker" width="860" />
</p>

Deployment is now complete. Open your configured workers.dev or custom domain to enter the dashboard:

```url
https://your.domain.com/
```

Open the private workspace, enter `AUTH_CODE`, then create a counter, preview the badge, and copy Markdown / HTML / Image URL into your README or website.

## Dashboard

The dashboard creates counters, previews badges, generates embed links, and manages existing counters. The public landing page is **a showcase only, not a free badge-hosting service**. Visitors cannot create working badges using the owner's D1 database: deploy the repository to your own Cloudflare account and set your own `AUTH_CODE`.

Inside the private workspace, **Use** loads an existing badge; **Edit** lets you change its style or migrate its URL / counter key while retaining the total count, daily history and badge config. Existing badge URLs using the old **counter key** are compatible via an alias, but a change to the Worker's **hostname** still requires updating that hostname in your embeds. Old keys remain reserved as aliases until the counter is deleted. Renaming back to your own old key is supported.

| Field            | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| Auth Code        | Required for create, load, and delete.                       |
| URL              | Real counter key for the badge data and status page.         |
| Badge Label      | Display text only. It does not change the counter key.       |
| Label Background | Left-side badge color. Default `#A4D3EE`.                    |
| Count Background | Right-side count color. Default `#555555`.                   |
| Badge Style      | `flat`, `flat-square`, `plastic`, `for-the-badge`, `social`. |
| Badge Type       | `today / total` by default, or `total only`.                 |

## History Retention

Use one setting:

```js
const HISTORY_DAYS = 30
```

It controls the default status page range, default history SVG range, maximum accepted `?days=` value, and daily row retention in D1.

Total visits are permanent until the counter is deleted. Increasing `HISTORY_DAYS` keeps existing daily rows and lets the chart grow into the new window; daily rows already deleted cannot be restored. Decreasing it removes older daily rows on the next cleanup.

## Examples

The output panel has two modes: `Saved style` generates stable short links and loads style from D1; `Custom URL` generates links with full style parameters for one-off customization. Existing stable embeds automatically use the latest dashboard style.

```md
![Visitors](https://your.domain.com/api/combined?path=https%3A%2F%2Fexample.com%2F)
```

```html
<a href="https://your.domain.com/status?path=https%3A%2F%2Fexample.com%2F" target="_blank" rel="noopener noreferrer">
  <img src="https://your.domain.com/api/combined?path=https%3A%2F%2Fexample.com%2F" alt="Visitor badge" />
</a>
```

## Documentation

| Document                             | Content                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| [API Reference](docs/API.md)         | Badge, status, management, and compatibility endpoints. |
| [Architecture](docs/ARCHITECTURE.md) | D1 data model, hot path, and cost design.               |
| [Security](docs/SECURITY.md)         | Auth Code, public URL boundary, and privacy notes.      |
| [Roadmap](docs/ROADMAP.md)           | Planned improvements.                                   |

## License

This project is licensed under the [MIT License](LICENSE).
