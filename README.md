# OpenSpecSight

OpenSpecSight is a self-hosted app that keeps your product spec alive: it connects to
your GitHub repository, runs an LLM analysis to generate the living spec (features and
scenarios), records changes per release through syncs (manual or webhook-triggered),
and lets you browse everything in a clean UI.

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

## Automatic syncs (GitHub webhook)

Set `GITHUB_WEBHOOK_SECRET` in `.env`, then add a webhook on the GitHub
repository: payload URL `http://your-host/api/webhooks/github`, content type
`application/json`, and that secret. Requests are verified against their HMAC
signature, and a push to a branch a project watches starts that project's sync
automatically. It is the same sync as the **Sync now** button: new commits
become releases, and a push with nothing new finishes as an up-to-date
no-op. The Settings page shows the exact URL and whether the secret is
configured; without it the endpoint answers 503 and enqueues nothing. A
delivery with a bad signature is rejected with 401 and enqueues nothing.

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
Relations and flows are re-derived per analysis, so a feature kept only through
manual edits may appear in the spec without map connections until the next
full re-analysis.

## Digests and email

A digest wraps one week of releases into a short summary for people who do
not watch the repository. Create one from a project's **Digests** section:
**New digest** prefills the last seven days, and you can set any range. A
digest that was never emailed is still useful. It renders on its own page
with its blocks, and nothing pretends it went out.

Email delivery needs SMTP in `.env`:

| Key | Meaning |
| --- | --- |
| `SMTP_HOST` | Defaults to `smtp.gmail.com` |
| `SMTP_PORT` | Defaults to `587` (STARTTLS) |
| `SMTP_USER` | The account that signs in to the SMTP server |
| `SMTP_PASS` | That account's password or app password |
| `SMTP_FROM` | The From address on outgoing mail |
| `DIGEST_RECIPIENTS` | Comma-separated list of digest recipients |

For Gmail, create an [app password](https://myaccount.google.com/apppasswords)
(2-step verification required) and put it in `SMTP_PASS`; Gmail's SMTP
rejects a regular account password.

The scheduled weekly run is off by default. Set `DIGEST_WEEKLY_ENABLED=true`
to run it every Monday at 09:00 server time for each project with releases
in the past week, or trigger a run by hand with
`npx nuxt task run digests:weekly`. Without SMTP, the run stays honest:
digests are generated and stored anyway, the **Email to recipients** button
is disabled with the reason on the page, and the send API answers
`{ sent: false, reason: "SMTP is not configured" }` instead of claiming a
send. A digest is marked emailed only after a real delivery. Emailed
digests link back to the app through `PUBLIC_APP_URL`, so set it to a URL
your recipients can reach.

## Release notes

Release notes are AI-drafted summaries of a release, written for people who
do not read commits. Draft one from the **Release notes** section: pick a
release (or a date range) and a voice, and the LLM drafts a title and
blocks. A voice is a standing instruction for how this project's notes
should sound; the default voice needs no setup, and projects can add their
own. If a voice is deleted, existing notes keep the default voice instead
of breaking.

The draft opens in a block editor: edit the title and every block, add,
move, or delete blocks, and rewrite one paragraph with **Enhance**. Edits
autosave. **Publish** puts the note on a public page at `/notes/<slug>`
that anyone can read without an account. Drafts and unpublished notes 404
there; a missing page says nothing about whether a draft exists.

## Export

The **Product spec** page has a download button (top right). It hands the
browser one Markdown file with the whole spec: features with their
scenarios and the annotations on them, the feature connections, and the
release history, named after the project.

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
