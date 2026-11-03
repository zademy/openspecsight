# OpenSpecSight

OpenSpecSight is a self-hosted app that keeps your product spec alive: it connects to
your GitHub repository, runs an LLM analysis to generate the living spec (features and
scenarios), records changes per release through manual syncs, and lets you browse
everything in a clean UI.

## Requirements

- Node.js >= 24
- [pnpm](https://pnpm.io/) 10.x

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local env file (see .env.example for every key)
cp .env.example .env

# 3. Start the dev server
pnpm dev
```

The app is now available at <http://localhost:3000>.

## Scripts

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `pnpm dev`        | Start the Nuxt dev server                    |
| `pnpm build`      | Build the production bundle                  |
| `pnpm preview`    | Preview the production build                 |
| `pnpm lint`       | Run ESLint                                   |
| `pnpm test:unit`  | Run unit tests (vitest)                      |
| `pnpm test:e2e`   | Run end-to-end tests (Playwright)            |

## Configuration

Configuration is **env-only** — see [`.env.example`](./.env.example) for every key
and its default. Secrets (GitHub PAT, LLM API key, session secret, auth password)
are never committed, logged, or returned by the API.

## Testing

```bash
pnpm test:unit   # vitest, tests/unit/**/*.spec.ts and shared/**/*.spec.ts
pnpm test:e2e    # Playwright; boots the dev server and a local GitHub API stub (127.0.0.1:9876)
```

## License

[MIT](./LICENSE)
