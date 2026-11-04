import type { GithubService } from '../github.service'
import type { CodeFile } from './paths'

/**
 * Builds the compact source digest the LLM reasons over: one section per
 * scanned file with its path and (truncated) contents. Reads happen in small
 * concurrent batches, oversize blobs are skipped from the digest, and a whole
 * digest byte cap keeps the prompt bounded no matter how large the repo is.
 */

/** Blobs above this size never enter the digest (they are still counted as scanned files). */
const MAX_BLOB_BYTES = 512 * 1024

/** Per-file truncation point inside the digest. */
const MAX_FILE_BYTES = 16 * 1024

/** Whole-digest cap: once reached, remaining files are listed but not inlined. */
const MAX_DIGEST_BYTES = 400 * 1024

/** How many blobs are fetched concurrently per batch. */
const BLOB_BATCH_SIZE = 16

export interface SourceDigestResult {
  /** The full digest text handed to the inventory generate() call. */
  digest: string
  /**
   * Contents kept for the digest, by path, capped together with the digest.
   * Used to build per-feature prompts for the scenario step; files dropped
   * from the digest (oversize, over cap, failed read) are absent.
   */
  contentsByPath: Map<string, string>
}

/** Fetches the filtered files and renders their compact source digest. */
export async function buildSourceDigest(
  github: GithubService,
  owner: string,
  repo: string,
  files: CodeFile[],
): Promise<SourceDigestResult> {
  const contents = await readBlobContents(github, owner, repo, files)
  const { digest, contentsByPath } = renderDigest(owner, repo, files, contents)
  return { digest, contentsByPath }
}

/** Reads blob contents in bounded batches; failures degrade to a missing entry. */
async function readBlobContents(
  github: GithubService,
  owner: string,
  repo: string,
  files: CodeFile[],
): Promise<Map<string, string>> {
  const candidates = files.filter((file) => file.size <= MAX_BLOB_BYTES)
  const contents = new Map<string, string>()

  for (let start = 0; start < candidates.length; start += BLOB_BATCH_SIZE) {
    const batch = candidates.slice(start, start + BLOB_BATCH_SIZE)
    const settled = await Promise.allSettled(
      batch.map(async (file) => ({ file, content: await github.getBlob(owner, repo, file.sha) })),
    )
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        contents.set(result.value.file.path, result.value.content)
      }
      // A single unreadable blob must not fail the scan; the digest note says so.
    }
  }

  return contents
}

/** Renders the digest text and the capped per-path contents side by side. */
function renderDigest(owner: string, repo: string, files: CodeFile[], contents: Map<string, string>): SourceDigestResult {
  const header = `Source digest of ${owner}/${repo} — ${files.length} code files (build output, lockfiles and binaries were filtered out before this step)\n`
  const sections: string[] = []
  const contentsByPath = new Map<string, string>()
  let bytes = header.length
  const omitted: string[] = []

  for (const file of files) {
    if (file.size > MAX_BLOB_BYTES) {
      omitted.push(`- ${file.path}: skipped (${formatBytes(file.size)} over the ${formatBytes(MAX_BLOB_BYTES)} per-file cap)`)
      continue
    }
    const content = contents.get(file.path)
    if (content === undefined) {
      omitted.push(`- ${file.path}: could not be read`)
      continue
    }

    const kept = content.length > MAX_FILE_BYTES
      ? `${content.slice(0, MAX_FILE_BYTES)}\n[… truncated after ${formatBytes(MAX_FILE_BYTES)}]`
      : content
    const section = `\n--- ${file.path} ---\n${kept}\n`
    if (bytes + section.length > MAX_DIGEST_BYTES) {
      omitted.push(`- ${file.path}: omitted (digest reached the ${formatBytes(MAX_DIGEST_BYTES)} cap)`)
      continue
    }

    bytes += section.length
    sections.push(section)
    contentsByPath.set(file.path, kept)
  }

  let digest = header + sections.join('')
  if (omitted.length > 0) {
    digest += `\n--- files not included in this digest ---\n${omitted.join('\n')}\n`
  }
  return { digest, contentsByPath }
}

/**
 * Renders the per-feature prompt for the scenario step: the feature plus the
 * digest sections of the files the inventory claims implement it (only those
 * that are actually part of this scan). Files not in the scan are listed so
 * the model knows they exist but were not captured.
 */
export function buildFeatureDigest(
  feature: { name: string, description: string, files: string[] },
  contentsByPath: Map<string, string>,
): string {
  const sections: string[] = []
  const missing: string[] = []
  for (const path of feature.files) {
    const content = contentsByPath.get(path)
    if (content === undefined) {
      missing.push(path)
    } else {
      sections.push(`\n--- ${path} ---\n${content}\n`)
    }
  }

  let digest = `Feature: ${feature.name}\n${feature.description}\n`
  digest += sections.length > 0
    ? `\nSource files of this feature:${sections.join('')}`
    : '\nNone of this feature\'s files were captured in the scan; infer from the repository summary.\n'
  if (missing.length > 0) {
    digest += `\nReferenced but not captured: ${missing.join(', ')}\n`
  }
  return digest
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`
  }
  return `${Math.round(bytes / 1024)} KB`
}
