# Folio

A small local-first task tracker for groups of friends.

## Local Development

Install dependencies:

```sh
npm install
```

Start the static app and sync Worker:

```sh
npm run dev
```

The default local URLs are:

- Web app: `http://localhost:8030`
- Sync Worker: `http://localhost:8798`

The frontend stores local state in `localStorage` under `folio_v2`.

## Production

The frontend deploys as a static GitHub Pages app. The sync API deploys as the `folio-sync` Cloudflare Worker with one Durable Object instance per invite code.

Set the production Worker URL in `app/config.js`:

```js
globalThis.FOLIO_CONFIG = {
  apiBaseUrl: "https://folio-sync.emh.workers.dev"
};
```

Add these GitHub repository secrets before relying on Worker deploys:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Deploy the Worker manually with:

```sh
npm run deploy:worker:sync
```

## Prototype

`prototype.html` remains the visual and interaction reference.
