import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ZodError } from 'zod'
import { createLlmClient, readLlmEnv } from '../../server/services/llm.service'
import { FeatureInventorySchema, FeatureScenariosSchema } from '../../shared/schemas'
import type { FeatureInventory } from '../../shared/types'

/**
 * The service reads env when createLlmClient() is called, so each test sets
 * its LLM_* vars in its own body (vitest.config.ts sets no env on purpose).
 * The suite never reaches the network: mock mode reads fixture files, and
 * real-mode tests inject a model factory plus a generate stub.
 */
const FIXTURES_DIR = path.resolve(process.cwd(), 'fixtures/llm')

beforeEach(() => {
  delete process.env.LLM_API_STYLE
  delete process.env.LLM_BASE_URL
  delete process.env.LLM_API_KEY
  delete process.env.LLM_MODEL
  delete process.env.LLM_MOCK
})

/** A LanguageModel-shaped stub that fails loudly if anything tries to use it. */
function offlineModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'unit-test',
    modelId: 'offline',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('unit tests must not reach the real LLM')
    },
    doStream: async () => {
      throw new Error('unit tests must not reach the real LLM')
    },
  }
}

const inventoryPayload: FeatureInventory = {
  features: [
    {
      name: 'Authentication',
      description: 'Login and logout.',
      files: ['server/api/auth/login.post.ts'],
    },
  ],
}

describe('mock mode (LLM_MOCK=true)', () => {
  test('returns the fixture for the resolved name, validated against the schema', async () => {
    process.env.LLM_MOCK = 'true'
    const fixture = JSON.parse(await readFile(path.join(FIXTURES_DIR, 'feature-inventory.json'), 'utf8'))

    const result = await createLlmClient().generate('feature-inventory', FeatureInventorySchema, 'ignored')

    expect(result).toEqual(fixture)
  })

  test('maps ":" in the name to "." in the fixture file name', async () => {
    process.env.LLM_MOCK = 'true'
    const fixture = JSON.parse(await readFile(path.join(FIXTURES_DIR, 'feature-scenarios.authentication.json'), 'utf8'))

    const result = await createLlmClient().generate('feature-scenarios:authentication', FeatureScenariosSchema, 'ignored')

    expect(result).toEqual(fixture)
  })

  test('rejects an unknown fixture name', async () => {
    process.env.LLM_MOCK = 'true'

    await expect(
      createLlmClient().generate('no-such-output', FeatureInventorySchema, 'ignored'),
    ).rejects.toThrow(/Unknown LLM fixture/)
  })

  test('rejects a fixture payload that violates the schema', async () => {
    process.env.LLM_MOCK = 'true'
    const client = createLlmClient({
      readFixture: async () => ({ features: [{ name: 'Broken', description: 'files is missing' }] }),
    })

    await expect(client.generate('feature-inventory', FeatureInventorySchema, 'ignored')).rejects.toThrowError(ZodError)
  })

  test('rejects names that escape the fixtures directory', async () => {
    process.env.LLM_MOCK = 'true'

    await expect(
      createLlmClient().generate('../secrets', FeatureInventorySchema, 'ignored'),
    ).rejects.toThrow(/Invalid LLM fixture name/)
  })
})

describe('real mode (LLM_MOCK=false)', () => {
  test('builds the model from env at construction and never generates', () => {
    process.env.LLM_MOCK = 'false'
    process.env.LLM_API_STYLE = 'fake-style'
    process.env.LLM_BASE_URL = 'https://llm.example.test/v1'
    process.env.LLM_API_KEY = 'test-key'
    process.env.LLM_MODEL = 'test-model'
    const createModel = vi.fn(() => offlineModel())
    const generate = vi.fn()

    expect(() => createLlmClient({ createModel, generate })).not.toThrow()

    expect(createModel).toHaveBeenCalledOnce()
    expect(createModel.mock.calls[0]?.[0]).toEqual({
      apiStyle: 'fake-style',
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'test-key',
      model: 'test-model',
      mock: false,
    })
    expect(generate).not.toHaveBeenCalled()
  })

  test('applies env defaults when no LLM_* variable is set', () => {
    process.env.LLM_MOCK = 'false'
    const createModel = vi.fn(() => offlineModel())

    createLlmClient({ createModel })

    expect(createModel.mock.calls[0]?.[0]).toEqual({
      apiStyle: 'anthropic',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiKey: '',
      model: '',
      mock: false,
    })
  })

  test('the default provider factory rejects an unknown API style', () => {
    process.env.LLM_MOCK = 'false'
    process.env.LLM_API_STYLE = 'bogus'
    process.env.LLM_MODEL = 'test-model'

    expect(() => createLlmClient()).toThrow(/Unsupported LLM_API_STYLE/)
  })

  test('generates with the built model and validates the output against the schema', async () => {
    process.env.LLM_MOCK = 'false'
    process.env.LLM_API_STYLE = 'anthropic'
    const model = offlineModel()
    const createModel = vi.fn(() => model)
    const generate = vi.fn(async () => inventoryPayload)
    const client = createLlmClient({ createModel, generate })

    const result = await client.generate('feature-inventory', FeatureInventorySchema, 'inventory prompt')

    expect(result).toEqual(inventoryPayload)
    expect(createModel).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]?.[0]?.model).toBe(model)
    expect(generate.mock.calls[0]?.[0]?.schema).toBe(FeatureInventorySchema)
    expect(generate.mock.calls[0]?.[0]?.prompt).toBe('inventory prompt')
  })
})

describe('readLlmEnv()', () => {
  test('reads the LLM_* variables with trimmed values and true-only mocking', () => {
    const env = readLlmEnv({
      LLM_API_STYLE: ' openai ',
      LLM_BASE_URL: ' https://llm.example.test/v1 ',
      LLM_API_KEY: ' key ',
      LLM_MODEL: ' model ',
      LLM_MOCK: 'TRUE',
    })

    expect(env).toEqual({
      apiStyle: 'openai',
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'key',
      model: 'model',
      mock: true,
    })
  })

  test('treats anything but "true" as mocking disabled', () => {
    expect(readLlmEnv({ LLM_MOCK: '1' }).mock).toBe(false)
    expect(readLlmEnv({}).mock).toBe(false)
  })
})
