import { AskAnswerSchema } from '../../shared/schemas'
import type { AskAnswer, AskCitation, AskResult } from '../../shared/types'
import { getDB, type Database } from '../db/client'
import { searchScenarios, type ScenarioSearchHit } from '../db/search'
import { createLlmClient, type LlmClient } from './llm.service'

/**
 * The Ask pipeline: answer a question strictly from the project's stored
 * scenarios. Honesty rules (Review Focus #1): an empty question and a
 * zero-result retrieval refuse without ever calling the LLM, and a
 * `covered:false` model verdict surfaces verbatim as a refusal. Citations
 * are grounded before display — a citation survives only if its scenarioId
 * was actually retrieved, and answer markers without a surviving citation
 * are stripped, so the UI can never render a fabricated link.
 */

/** Refusal copy for a question with nothing in it. */
export const EMPTY_QUESTION_ANSWER = 'Ask a question about the product first. Answers come only from its spec.'

/** Refusal copy for a question the spec has no scenarios for. */
export const NO_COVERAGE_ANSWER = "The spec doesn't cover that yet. It only holds what the analysis found in the code."

/** How many retrieval hits feed the prompt (and thus the citation numbering). */
const RETRIEVAL_LIMIT = 8

const MARKER = /\[(\d+)\]/g

export interface AskDeps {
  db?: Database
  llm?: LlmClient
}

export async function ask(projectId: number, question: string, deps: AskDeps = {}): Promise<AskResult> {
  const trimmed = question.trim()
  if (trimmed === '') {
    return { answer: EMPTY_QUESTION_ANSWER, refused: true, citations: [] }
  }

  const db = deps.db ?? getDB()
  const hits = await searchScenarios(db, projectId, trimmed, RETRIEVAL_LIMIT)
  if (hits.length === 0) {
    return { answer: NO_COVERAGE_ANSWER, refused: true, citations: [] }
  }

  const llm = deps.llm ?? createLlmClient()
  const raw = await llm.generate('ask-answer', AskAnswerSchema, buildAskPrompt(trimmed, hits))
  if (!raw.covered) {
    return { answer: raw.answer, refused: true, citations: [] }
  }

  const grounded = groundAnswer(raw, hits)
  return { answer: grounded.answer, refused: false, citations: grounded.citations }
}

/**
 * Prompt for the ask step: the retrieved scenarios numbered 1..N with their
 * live scenario ids (the numbering is what citation `index` values reference;
 * the ids are what citation `scenarioId` must carry — without them a real
 * model can only ground by coincidence), the question, and the grounding
 * instructions — answer only from these scenarios, cite with [n] and the
 * shown id, bow out with covered:false when they do not cover it.
 */
function buildAskPrompt(question: string, hits: ScenarioSearchHit[]): string {
  const lines = hits.map((hit, position) =>
    `${position + 1}. [${hit.code}] (scenarioId: ${hit.scenarioId}) ${hit.featureName} / ${hit.context}: ${hit.action} → ${hit.outcome}`,
  )
  return [
    'Scenarios from the product spec:',
    '',
    ...lines,
    '',
    'Answer the question below using only these scenarios. Cite every claim with the scenario number in brackets, like [1], and give each citation the {index, scenarioId} pair shown for that scenario. If the scenarios do not cover the question, set covered to false and make the answer a one-line reason.',
    '',
    `Question: ${question}`,
  ].join('\n')
}

/**
 * Grounds a model answer against the retrieval set, in three passes:
 *  1. Drop citations whose scenarioId is not in the retrieval set (first
 *     citation per marker index wins).
 *  2. Walk the answer's [n] markers left to right: markers with no surviving
 *     citation are stripped; surviving ones are re-indexed 1..N in first-
 *     appearance order and the markers remapped to the new numbers.
 *  3. Citations no marker references come last, sorted by prompt index,
 *     so survivor order stays prompt order whatever order they arrived in.
 */
function groundAnswer(raw: AskAnswer, hits: ScenarioSearchHit[]): { answer: string, citations: AskCitation[] } {
  const hitByScenarioId = new Map(hits.map((hit) => [hit.scenarioId, hit]))

  const byIndex = new Map<number, AskCitation>()
  for (const citation of raw.citations) {
    const hit = hitByScenarioId.get(citation.scenarioId)
    if (!hit || byIndex.has(citation.index)) {
      continue
    }
    byIndex.set(citation.index, {
      index: citation.index,
      scenarioId: hit.scenarioId,
      code: hit.code,
      featureId: hit.featureId,
      featureName: hit.featureName,
      quote: citation.quote,
    })
  }

  const citations: AskCitation[] = []
  const displayIndexByOriginal = new Map<number, number>()
  let stripped = false
  let answer = raw.answer.replaceAll(MARKER, (_marker, original: string) => {
    const citation = byIndex.get(Number.parseInt(original, 10))
    if (!citation) {
      stripped = true
      return ''
    }
    let displayIndex = displayIndexByOriginal.get(citation.index)
    if (displayIndex === undefined) {
      displayIndex = citations.length + 1
      displayIndexByOriginal.set(citation.index, displayIndex)
      citation.index = displayIndex
      citations.push(citation)
    }
    return `[${displayIndex}]`
  })

  const unreferenced = [...byIndex]
    .filter(([original]) => !displayIndexByOriginal.has(original))
    .sort(([a], [b]) => a - b)
  for (const [original, citation] of unreferenced) {
    displayIndexByOriginal.set(original, citations.length + 1)
    citation.index = citations.length + 1
    citations.push(citation)
  }

  // Only touch whitespace where a marker was actually removed, so clean
  // answers pass through verbatim.
  if (stripped) {
    answer = answer.replace(/ {2,}/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim()
  }
  return { answer, citations }
}
