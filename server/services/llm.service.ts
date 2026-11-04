import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateObject } from 'ai'
import type { LanguageModel } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'

/**
 * Structured-output LLM client. `generate(name, schema, prompt, opts?)`
 * returns a value validated against the zod schema:
 * - Mock mode (`LLM_MOCK=true`) returns the fixture `fixtures/llm/<name>.json`
 *   (a `:` in `name` becomes a `.`, so `'sync-update:authentication'` reads
 *   `sync-update.authentication.json`), validated against the same schema.
 *   With `opts.projectId` it resolves `<name>-<projectId>.json` first and
 *   falls back to the base fixture when that file does not exist, so ask
 *   tests script answers per project instead of racing on one shared file.
 * - Real mode builds a provider from `LLM_API_STYLE`/`LLM_BASE_URL`/`LLM_API_KEY`
 *   and runs AI SDK `generateObject` with `LLM_MODEL`.
 *
 * All env is read when `createLlmClient()` is called, not at module load, so
 * create a fresh client per use. The unit tests never reach the network: they
 * run in mock mode and inject `createModel`/`generate` in real mode.
 */
export interface LlmClient {
  generate<T>(name: string, schema: z.ZodType<T>, prompt: string, opts?: GenerateOpts): Promise<T>
}

/**
 * Optional per-call hints. Mock mode uses `projectId` to resolve the
 * per-project fixture variant first; real mode ignores the hints.
 */
export interface GenerateOpts {
  readonly projectId?: number
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
  /** Mock mode: whether a fixture file exists (per-project variant lookup). */
  hasFixture?: (filename: string) => boolean
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
    const hasFixture = deps.hasFixture ?? hasFixtureOnDisk
    return {
      async generate<T>(name: string, schema: z.ZodType<T>, _prompt: string, opts?: GenerateOpts): Promise<T> {
        const base = fixtureFileName(name)
        const variant = opts?.projectId === undefined ? base : variantFileName(base, opts.projectId)
        const raw = await readFixture(variant !== base && hasFixture(variant) ? variant : base)
        return schema.parse(raw)
      },
    }
  }

  const model = (deps.createModel ?? createDefaultModel)(env)
  const runGenerate = deps.generate ?? generateWithSdk

  return {
    async generate<T>(name: string, schema: z.ZodType<T>, prompt: string): Promise<T> {
      const raw = await runGenerate({ model, schema, prompt: `${prompt}\n\n${zodShapeHint(schema)}` })
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

/** Appends the per-project suffix: `ask-answer.json` + 42 → `ask-answer-42.json`. */
function variantFileName(filename: string, projectId: number): string {
  return `${filename.replace(/\.json$/, '')}-${projectId}.json`
}

function hasFixtureOnDisk(filename: string): boolean {
  return existsSync(join(resolveFixturesDir(), filename))
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

/**
 * Users routinely paste the full endpoint URL from provider docs (e.g.
 * "https://api.minimax.io/v1/chat/completions" or an Anthropic
 * ".../messages" URL) into LLM_BASE_URL, but the SDKs expect the base URL
 * and append their own path — a full URL would double the path and 404.
 * Strip the known endpoint suffixes so both spellings work.
 */
export function toBaseUrl(url: string): string {
  return url.replace(/\/(?:chat\/completions|messages|completions|embeddings)\/?$/i, '')
}

function createDefaultModel(env: LlmEnv): LanguageModel {
  if (!env.model) {
    throw new Error('LLM_MODEL is not set; it must name the model to call when LLM_MOCK is false')
  }
  const apiKey = env.apiKey || undefined
  const baseURL = toBaseUrl(env.baseUrl)
  switch (env.apiStyle) {
    case 'anthropic':
      return createAnthropic({ baseURL, apiKey })(env.model)
    case 'openai':
    case 'openai-compatible':
      // openai-compatible keeps the JSON schema in the prompt (no
      // response_format json_schema), which is where weak-endpoint models
      // actually read it; the shape hint + repair pass in generateWithSdk
      // cover the rest.
      return createOpenAICompatible({ baseURL, apiKey, name: 'openspecsight' })(env.model)
    default:
      throw new Error(`Unsupported LLM_API_STYLE: ${env.apiStyle} (expected "anthropic", "openai", or "openai-compatible")`)
  }
}

async function generateWithSdk(args: { model: LanguageModel, schema: z.ZodType, prompt: string }): Promise<unknown> {
  const { object } = await generateObject({
    model: args.model,
    schema: args.schema,
    prompt: args.prompt,
    experimental_repairText: repairStructuredText(args.schema),
  })
  return object
}

/**
 * Some OpenAI-compatible endpoints (MiniMax among them) accept but silently
 * ignore `response_format: json_schema`, so the model never sees the schema
 * and invents its own JSON shape. A compact, human-readable shape hint in the
 * prompt plus a repair pass for the two classic failure modes (markdown
 * fences, and a bare array where the schema expects a wrapper object) makes
 * weak-endpoint models conform. Applied in real mode for every generate call.
 */
export function zodShapeHint(schema: z.ZodType): string {
  const shape = compactShape(schema)
  return `Respond ONLY with a single JSON ${shape}. No markdown, no code fences, no commentary.`
}

function compactShape(schema: z.ZodType): string {
  if (schema instanceof z.ZodObject) {
    const entries = Object.entries(schema.shape).map(([key, value]) => `${key}: ${compactShape(value as z.ZodType)}`)
    return `object of this exact shape: {${entries.join(', ')}}`
  }
  if (schema instanceof z.ZodArray) {
    return `array of ${compactShape(schema.element as z.ZodType)}`
  }
  if (schema instanceof z.ZodString) return 'string'
  if (schema instanceof z.ZodNumber) return 'number'
  if (schema instanceof z.ZodBoolean) return 'boolean'
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return compactShape(schema.unwrap() as z.ZodType)
  }
  if (schema instanceof z.ZodEnum) {
    return `one of ${schema.options.map(o => JSON.stringify(o)).join(' | ')}`
  }
  if (schema instanceof z.ZodUnion) {
    return schema.options.map(o => compactShape(o as z.ZodType)).join(' | ')
  }
  return 'value'
}

/** Repair text for generateObject: strip fences, wrap bare arrays into the schema's single-array wrapper. */
export function repairStructuredText(schema: z.ZodType) {
  return async ({ text }: { text: string, error: unknown }): Promise<string | null> => {
    let cleaned = text.trim()
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    try {
      const parsed: unknown = JSON.parse(cleaned)
      if (Array.isArray(parsed)) {
        const wrapper = singleArrayWrapperKey(schema)
        if (wrapper) {
          return JSON.stringify({ [wrapper]: parsed })
        }
      }
    } catch {
      // not JSON after cleaning; return the cleaned text and let the parser report
    }
    return cleaned
  }
}

function singleArrayWrapperKey(schema: z.ZodType): string | null {
  if (schema instanceof z.ZodObject) {
    const entries = Object.entries(schema.shape)
    const required = entries.filter(([, v]) => !(v instanceof z.ZodOptional))
    const only = required[0]
    if (required.length === 1 && only && only[1] instanceof z.ZodArray) {
      return only[0]
    }
  }
  return null
}
