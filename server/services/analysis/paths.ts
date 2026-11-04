import type { GithubTreeEntry } from '../github.service'

/**
 * Path-level rules for the initial scan: which tree entries count as code
 * files worth showing to the LLM. The allowlist is deliberately narrow —
 * everything the digest cannot use (binaries, lockfiles, build output) is
 * dropped before any blob is fetched.
 */

/** File extensions the pipeline treats as readable source. */
const CODE_EXTENSIONS = new Set([
  'ts', 'js', 'mjs', 'vue', 'json', 'md', 'css', 'py', 'go', 'rs', 'rb', 'java', 'php',
])

/** Dependency-lock files: they are `json`/`yaml` shaped but pure noise. */
const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'go.sum',
])

/** Directory names that mark generated or vendored output, skipped entirely. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage'])

/** Extensions that decode to mojibake rather than text. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'avif', 'pdf', 'zip', 'gz', 'tar', 'br',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'sqlite', 'db',
])

/** A tree entry that passed the code-file filter. */
export interface CodeFile {
  path: string
  sha: string
  size: number
}

/** Keeps blob entries with a code extension, minus lockfiles, build output and binaries. */
export function filterCodeFiles(entries: GithubTreeEntry[]): CodeFile[] {
  const files: CodeFile[] = []
  for (const entry of entries) {
    if (entry.type !== 'blob' || !isCodePath(entry.path)) {
      continue
    }
    files.push({ path: entry.path, sha: entry.sha, size: entry.size })
  }
  return files
}

/** True when a path should feed the source digest. */
export function isCodePath(path: string): boolean {
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  if (name.startsWith('.') || LOCKFILE_NAMES.has(name)) {
    return false
  }
  if (segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
    return false
  }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return false
  }
  const extension = name.slice(dot + 1).toLowerCase()
  return CODE_EXTENSIONS.has(extension) && !BINARY_EXTENSIONS.has(extension)
}

/**
 * Lowercased kebab-case slug of a feature name, used to build the LLM output
 * name `feature-scenarios:<slug>` (and, in mock mode, its fixture file name):
 * `Authentication` → `authentication`, `Task list` → `task-list`.
 */
export function featureSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}
