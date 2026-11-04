# OpenSpecSight

OpenSpecSight is a self-hosted app that keeps your product spec alive: it connects to
your GitHub repository, runs an LLM analysis to generate the living spec (features and
scenarios), records changes per release through manual syncs, and lets you browse
everything in a clean UI.

## Requirements

- Node.js >= 24 (`engines` is enforced; older versions fail in `pnpm install`)
- [pnpm](https://pnpm.io/) 10.x

## Quickstart (no API keys)

The app runs end to end without any provider account: the LLM client answers from
checked-in fixture data when `LLM_MOCK=true`, and public GitHub repositories need no
token.

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local env file
cp .env.example .env
```

Edit `.env` and set the two values that have no defaults:

```bash
AUTH_PASSWORD=any-password-you-want    # the single-operator login
SESSION_SECRET=any-long-random-string  # signs session cookies and encrypts stored PATs
LLM_MOCK=true                          # fixture LLM answers, no network calls
```

Start the dev server and open <http://localhost:3000>:

```bash
pnpm dev
```

Log in with your `AUTH_PASSWORD`, create a project for a public repository (for
example `nuxt`/`nuxt`), and click **Run analysis** on the overview.

One honest caveat about mock mode: the analysis and syncs read their results from
`fixtures/llm/*.json`, so the spec you get is demo data, not an analysis of the
repository you pointed at. The GitHub calls are real; the LLM is the only mocked
part. It exists so you can exercise the whole flow — create, analyze, edit, sync —
before configuring a provider.

## Connecting an LLM provider

Fill the `LLM_*` keys in `.env` (and set `LLM_MOCK=false` or remove it):

| Key | Meaning |
| --- | --- |
| `LLM_API_STYLE` | `anthropic` (default) or `openai-compatible` |
| `LLM_BASE_URL` | Provider endpoint; defaults to the MiniMax coding plan endpoint `https://api.minimax.io/anthropic` |
| `LLM_API_KEY` | Your provider key. Read server-side only; never logged, never returned by the API |
| `LLM_MODEL` | Model name your provider expects |

Any Anthropic-style endpoint works with `LLM_API_STYLE=anthropic`. For an
OpenAI-compatible provider (vLLM, OpenRouter, local gateways), set
`LLM_API_STYLE=openai-compatible` and point `LLM_BASE_URL` at its `/v1` root.
Configuration is env-only — [`.env.example`](./.env.example) is the full key
reference.

For private repositories, set a `GITHUB_TOKEN` (or paste a personal access token
when creating a project). Tokens are encrypted with `SESSION_SECRET` before they
are stored and are never included in an API response.

## Product map, flows, and Ask

The analysis reads more out of your code than the scenario list. It records how
features relate (the **Product map** section draws those relations as a graph
you can search and click through into the spec) and how a feature behaves,
drawn as a flow diagram next to its scenarios. **Ask** is a question box over
the same data: it retrieves scenarios, answers only from them, and links every
claim to the scenario row it came from. When the spec doesn't cover a question,
Ask says so instead of inventing an answer.

In mock mode all three run on fixtures: the map, the flows, and the ask answers
come from checked-in data, no provider keys needed. With a real provider, each
sync refreshes the map and flows for the features a commit touched, and ask
answers come from your configured model, still grounded in the stored spec.

## Scripts

| Command           | Description                                  |
| ----------------- | -------------------------------------------- |
| `pnpm dev`        | Start the Nuxt dev server                    |
| `pnpm build`      | Build the production bundle                  |
| `pnpm preview`    | Preview the production build                 |
| `pnpm lint`       | Run ESLint                                   |
| `pnpm typecheck`  | Run `tsc -b` over the project                |
| `pnpm test:unit`  | Run unit tests (vitest)                      |
| `pnpm test:e2e`   | Run end-to-end tests (Playwright)            |

## Testing

```bash
pnpm test:unit   # vitest, tests/unit/**/*.spec.ts and shared/**/*.spec.ts
pnpm test:e2e    # Playwright; hermetic: no API keys, no network
```

The e2e suite boots a fixture-driven GitHub API stub on `127.0.0.1:9876` (see
`tests/helpers/github-stub.ts`) and runs against the **production build**
(`pnpm build && pnpm preview` in `playwright.config.ts`), not the dev server. Two
reasons, both learned the hard way:

- The dev server's request bridge can drop a JSON body that arrives mid-SSR-render;
  the built Nitro server serves requests on a plain HTTP server and does not have
  that problem.
- The built server reads migrations and LLM fixtures from disk paths resolved next
  to its own bundle; the build copies `server/db/migrations` and `fixtures/` into
  `.output` (see the `nitro.hooks.compiled` hook in `nuxt.config.ts`), so tests
  exercise exactly what a deployment runs.

## Troubleshooting

**`pnpm dev` fails or `pnpm install` warns about engines.** You are on Node < 24.
The project requires Node 24 or newer; check `node --version`.

**Nothing happens on port 3000, or the page is an old version of the app.** A
stale server is still listening. Kill it and start again:

```bash
lsof -ti :3000 | xargs kill
pnpm dev
```

**`pnpm preview` can't find LLM fixtures or fails on boot with a migration error.**
Your `.output` is stale. Migrations and fixtures are copied into `.output` at
build time, so after pulling changes run `pnpm build` before `pnpm preview`. In a
pinch, delete `.output` and rebuild.

**e2e tests hang on a POST.** You changed `playwright.config.ts` to use the dev
server. Keep the production build; see Testing above for why.

**Analysis or sync fails with a provider error.** With `LLM_MOCK=false`, check
that `LLM_MODEL` is a model your provider actually serves and that `LLM_BASE_URL`
matches the API style: Anthropic-style endpoints for `anthropic`, an OpenAI-style
`/v1` root for `openai-compatible`.

## License

[MIT](./LICENSE)
