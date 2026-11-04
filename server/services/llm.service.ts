import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateObject } from 'ai'
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { z } from 'zod'

/**
 * Structured-output LLM client. `generate(name, schema, prompt)` returns a
 * value validated against the zod schema:
 * - Mock mode (`LLM_MOCK=true`) returns the fixture `fixtures/llm/<name>.json`
 *   (a `:` in `name` becomes a `.`, so `'sync-update:authentication'` reads
 *   `sync-update.authentication.json`), validated against the same schema.
 * - Real mode builds a provider from `LLM_API_STYLE`/`LLM_BASE_URL`/`LLM_API_KEY`
 *   and runs AI SDK `generateObject` with `LLM_MODEL`.
 *
 * All env is read when `createLlmClient()` is called, not at module load, so
 * create a fresh client per use. The unit tests never reach the network: they
 * run in mock mode and inject `createModel`/`generate` in real mode.
 */
export interface LlmClient {
  generate<T>(name: string, schema: z.ZodType<T>, prompt: string): Promise<T>
}

/** Resolved LLM configuration handed to the provider factory. */
export interface LlmEnv {
  readonly apiStyle: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly mock: boolean
}

/**
 * Dependency seams for tests. Every member is optional; the defaults are the
 * filesystem fixture reader, the AI SDK provider factories, and `generateObject`.
 */
export interface LlmClientDeps {
  /** Real mode: build the language model from the resolved env. */
  createModel?: (env: LlmEnv) => LanguageModel
  /** Real mode: run one structured generation against the model. */
  generate?: (args: { model: LanguageModel, schema: z.ZodType, prompt: string }) => Promise<unknown>
  /** Mock mode: load the raw fixture JSON for a fixture file name. */
  readFixture?: (filename: string) => Promise<unknown>
}

const DEFAULT_API_STYLE = 'anthropic'
const DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic'

/**
 * Reads the LLM_* variables with defaults from .env.example: `LLM_API_STYLE`
 * defaults to `anthropic`, `LLM_BASE_URL` to the MiniMax Anthropic endpoint,
 * and only the literal string `true` (any case) enables mock mode.
 */
export function readLlmEnv(source: NodeJS.ProcessEnv = process.env): LlmEnv {
  return {
    apiStyle: source.LLM_API_STYLE?.trim() || DEFAULT_API_STYLE,
    baseUrl: source.LLM_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey: source.LLM_API_KEY?.trim() ?? '',
    model: source.LLM_MODEL?.trim() ?? '',
    mock: (source.LLM_MOCK?.trim().toLowerCase() ?? 'false') === 'true',
  }
}

export function createLlmClient(deps: LlmClientDeps = {}): LlmClient {
  const env = readLlmEnv()

  if (env.mock) {
    const readFixture = deps.readFixture ?? readFixtureFromDisk
    return {
      async generate<T>(name: string, schema: z.ZodType<T>): Promise<T> {
        const raw = await readFixture(fixtureFileName(name))
        return schema.parse(raw)
      },
    }
  }

  const model = (deps.createModel ?? createDefaultModel)(env)
  const runGenerate = deps.generate ?? generateWithSdk

  return {
    async generate<T>(name: string, schema: z.ZodType<T>, prompt: string): Promise<T> {
      const raw = await runGenerate({ model, schema, prompt })
      return schema.parse(raw)
    },
  }
}

/** Maps `'sync-update:authentication'` to `sync-update.authentication.json`. */
function fixtureFileName(name: string): string {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid LLM fixture name: ${name}`)
  }
  return `${name.replaceAll(':', '.')}.json`
}

async function readFixtureFromDisk(filename: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path.join(resolveFixturesDir(), filename), 'utf8')
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(`Unknown LLM fixture: ${filename} (expected a JSON file in ${resolveFixturesDir()})`, { cause: error })
    }
    throw error
  }
  const raw: unknown = JSON.parse(text)
  return raw
}

/**
 * Resolves the `fixtures/llm` folder by walking up from this module, mirroring
 * the migrations-folder lookup in server/db/client.ts: source layout finds the
 * project's `fixtures/llm` (dev, unit tests), and production builds find the
 * copy bundled next to the output (nuxt.config's compiled hook copies
 * `fixtures/` into `.output`, because `nuxt preview` runs with cwd = `.output`).
 */
function resolveFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, 'fixtures', 'llm')
    if (existsSync(candidate)) {
      return candidate
    }
    if (dir === dirname(dir)) {
      break
    }
  }
  throw new Error('LLM fixtures folder not found; expected fixtures/llm in the project or bundled into the build output')
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function createDefaultModel(env: LlmEnv): LanguageModel {
  if (!env.model) {
    throw new Error('LLM_MODEL is not set; it must name the model to call when LLM_MOCK is false')
  }
  const apiKey = env.apiKey || undefined
  switch (env.apiStyle) {
    case 'anthropic':
      return createAnthropic({ baseURL: env.baseUrl, apiKey })(env.model)
    case 'openai':
    case 'openai-compatible':
      return createOpenAICompatible({ baseURL: env.baseUrl, apiKey, name: 'openspecsight' })(env.model)
    default:
      throw new Error(`Unsupported LLM_API_STYLE: ${env.apiStyle} (expected "anthropic", "openai", or "openai-compatible")`)
  }
}

async function generateWithSdk(args: { model: LanguageModel, schema: z.ZodType, prompt: string }): Promise<unknown> {
  const { object } = await generateObject({ model: args.model, schema: args.schema, prompt: args.prompt })
  return object
}
