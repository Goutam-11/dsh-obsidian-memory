/**
 * Vault discovery, memory note storage, and recall ranking.
 *
 * Notes are plain Obsidian markdown files with YAML frontmatter, so the user
 * can read, edit, link, and search them like any other note.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SCOPES = ['global', 'project']

const TRASH_DIR = '.trash'
const MAX_BODY_BYTES = 20_000

/* ------------------------------------------------------------------ *
 * Vault discovery
 * ------------------------------------------------------------------ */

function obsidianConfigPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'obsidian', 'obsidian.json')
}

/** Registered vaults from Obsidian's own config, most recently seen first. */
export async function registeredVaults() {
  let raw
  try {
    raw = await fsp.readFile(obsidianConfigPath(), 'utf8')
  } catch {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const entries = Object.entries(parsed?.vaults ?? {})
  return entries
    .map(([id, value]) => ({
      id,
      path: typeof value?.path === 'string' ? value.path : '',
      open: value?.open === true,
      ts: typeof value?.ts === 'number' ? value.ts : 0,
    }))
    .filter((entry) => entry.path !== '')
    .sort((a, b) => Number(b.open) - Number(a.open) || b.ts - a.ts)
}

function samePath(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'linux' ? left === right : left.toLowerCase() === right.toLowerCase()
}

/**
 * Resolve the vault the memory lives in.
 * Order: explicit path, explicit name/id, a working directory inside a vault,
 * the active registered vault, then the CLI's own answer.
 */
export async function discoverVault(options, cli) {
  const explicitPath = typeof options.vaultPath === 'string' ? options.vaultPath.trim() : ''
  const explicitName = typeof options.vault === 'string' ? options.vault.trim() : ''

  if (explicitPath !== '') {
    return { path: path.resolve(explicitPath), name: path.basename(path.resolve(explicitPath)), source: 'config:vaultPath' }
  }

  const registered = await registeredVaults()

  if (explicitName !== '') {
    const byName = registered.find((entry) => path.basename(entry.path) === explicitName)
    const byId = registered.find((entry) => entry.id === explicitName)
    const byPath = path.isAbsolute(explicitName) ? { path: explicitName } : undefined
    const match = byName ?? byId ?? byPath
    if (match === undefined) {
      return {
        error: `configured vault "${explicitName}" is not registered in ${obsidianConfigPath()}; set vaultPath to the vault's absolute path instead`,
      }
    }
    return { path: match.path, name: path.basename(match.path), source: 'config:vault' }
  }

  const active = registered.find((entry) => entry.open) ?? registered[0]
  if (active !== undefined) {
    return { path: active.path, name: path.basename(active.path), source: 'obsidian.json' }
  }

  if (cli !== undefined) {
    const probed = await cli.vaultPath()
    if (typeof probed === 'string' && probed !== '') {
      return { path: probed, name: path.basename(probed), source: 'obsidian-cli' }
    }
  }
  return { error: `no Obsidian vault found: set vaultPath in the plugin config, or register a vault in ${obsidianConfigPath()}` }
}

/** A stable, human-readable folder key for one project directory. */
export function projectKeyFor(directory) {
  const resolved = path.resolve(directory)
  const base = slugify(path.basename(resolved)) || 'project'
  const digest = createHash('sha1').update(resolved).digest('hex').slice(0, 6)
  return `${base}-${digest}`
}

/** Normalise a configured path prefix so mapping lookups compare like with like. */
function normalizePrefix(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return ''
  const expanded = trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : trimmed
  return path.resolve(expanded)
}

/** The longest configured prefix containing the directory, or '' when none does. */
function matchingMapping(directory, mappings) {
  let best = { length: -1, key: '' }
  for (const [prefix, key] of Object.entries(mappings)) {
    const candidate = normalizePrefix(prefix)
    if (candidate === '' || typeof key !== 'string' || key.trim() === '') continue
    const inside = directory === candidate || directory.startsWith(`${candidate}${path.sep}`)
    if (inside && candidate.length > best.length) best = { length: candidate.length, key: key.trim() }
  }
  return best.key
}

/** Turn a git remote URL into a readable, stable folder key. */
export function slugifyRemote(remote) {
  const text = String(remote ?? '').trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  if (text === '') return ''
  // scp-like `git@host:owner/repo`, URL forms, and plain paths all end in owner/repo.
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(text)
  const rest =
    scp !== null
      ? scp[1]
      : text
          .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
          .replace(/^[^/]+\//, '')
  const segments = rest.split('/').filter((part) => part !== '')
  if (segments.length === 0) return ''
  return slugify(segments.slice(-2).join('-'))
}

/** `git -C <dir> config --get remote.origin.url`, tolerating a missing git or a non-repository. */
function gitRemoteOf(directory) {
  try {
    const output = execFileSync('git', ['-C', directory, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.trim()
  } catch {
    return ''
  }
}

const projectKeyCache = new Map()

/**
 * Resolve the memory scope key for a working directory.
 *
 * Precedence: an explicit `projectKeys` mapping, then the git `origin` remote
 * (stable across moves and clones), then the folder name plus a path hash.
 */
export function resolveProjectKey(directory, options = {}) {
  const resolved = path.resolve(directory)
  const mapped = matchingMapping(resolved, options.mappings ?? {})
  if (mapped !== '') return { projectKey: mapped, source: 'config', remote: '' }

  const cached = projectKeyCache.get(resolved)
  if (cached !== undefined) return cached

  const remote = gitRemoteOf(resolved)
  const fromRemote = remote === '' ? '' : slugifyRemote(remote)
  const entry =
    fromRemote === ''
      ? { projectKey: projectKeyFor(resolved), source: 'directory', remote: '' }
      : { projectKey: fromRemote, source: 'git-remote', remote }
  projectKeyCache.set(resolved, entry)
  return entry
}

/* ------------------------------------------------------------------ *
 * Note format
 * ------------------------------------------------------------------ */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function splitFrontmatter(text) {
  const match = FRONTMATTER.exec(text)
  if (match === null) return { raw: '', body: text }
  return { raw: match[1], body: text.slice(match[0].length) }
}

function parseScalar(value) {
  const trimmed = value.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter((item) => item !== '')
  }
  return trimmed.replace(/^["']|["']$/g, '')
}

/** Minimal YAML frontmatter reader for the keys this plugin writes. */
export function parseFrontmatter(text) {
  const { raw, body } = splitFrontmatter(text)
  const data = {}
  if (raw === '') return { data, body }

  let listKey = ''
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && listKey !== '') {
      const current = Array.isArray(data[listKey]) ? data[listKey] : []
      current.push(String(parseScalar(item[1])))
      data[listKey] = current
      continue
    }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null) continue
    listKey = pair[1]
    data[listKey] = pair[2].trim() === '' ? [] : parseScalar(pair[2])
  }
  return { data, body }
}

function quote(value) {
  return /^[\w./@+-]+$/.test(value) ? value : JSON.stringify(value)
}

function serializeNote(note) {
  const tags = note.tags.length === 0 ? '[]' : `[${note.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`
  const lines = [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    `scope: ${note.scope}`,
    `tags: ${tags}`,
    `importance: ${note.importance}`,
    `pinned: ${note.pinned ? 'true' : 'false'}`,
    `created: ${note.created}`,
    `updated: ${note.updated}`,
  ]
  if (note.scope === 'project' && note.project !== '') lines.push(`project: ${quote(note.project)}`)
  lines.push('---', '', note.body.trim(), '')
  return lines.join('\n')
}

export function slugify(text) {
  const normalized = String(text)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  const ascii = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (ascii !== '') return ascii.slice(0, 60)
  // Non-latin titles: keep the characters, which markdown and filesystems accept.
  const kept = String(text).trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-')
  return kept.slice(0, 60).replace(/^-+|-+$/g, '')
}

function toNote(text, scope, vaultRelativePath) {
  const { data, body } = parseFrontmatter(text)
  const rawTags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' && data.tags !== '' ? [data.tags] : []
  const importance = Number.isFinite(data.importance) ? Math.min(5, Math.max(1, Math.round(data.importance))) : 3
  return {
    scope,
    id: path.posix.basename(vaultRelativePath).replace(/\.md$/i, ''),
    path: vaultRelativePath,
    title: typeof data.title === 'string' && data.title !== '' ? data.title : path.posix.basename(vaultRelativePath, '.md'),
    tags: rawTags.map((tag) => String(tag).replace(/^#/, '').trim()).filter((tag) => tag !== ''),
    importance,
    pinned: data.pinned === true,
    created: typeof data.created === 'string' ? data.created : '',
    updated: typeof data.updated === 'string' ? data.updated.slice(0, 10) : '',
    project: typeof data.project === 'string' ? data.project : '',
    body: body.trim(),
  }
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

export function queryTerms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^#/, '').trim())
    .filter((term) => term !== '')
}

function countOccurrences(haystack, needle) {
  if (needle === '' || haystack === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function ageFactor(isoDate) {
  const stamp = Date.parse(isoDate)
  if (!Number.isFinite(stamp)) return 1
  const days = Math.max(0, (Date.now() - stamp) / 86_400_000)
  return 1 / (1 + days / 365)
}

/**
 * Score one note against a query.
 * Term hits are weighted per field, and durable signals (importance, pinned,
 * freshness) adjust the result so recall prefers what is worth remembering.
 */
export function scoreNote(note, terms, options = {}) {
  const title = note.title.toLowerCase()
  const tags = note.tags.join(' ').toLowerCase()
  const body = note.body.toLowerCase()
  let score = 0
  if (terms.length === 0) {
    score = note.importance * 2 + (note.pinned ? 4 : 0)
  } else {
    let hits = 0
    for (const term of terms) {
      const inTitle = countOccurrences(title, term)
      const inTags = countOccurrences(tags, term)
      const inBody = countOccurrences(body, term)
      hits += inTitle + inTags + inBody
      score += inTitle * 10 + inTags * 7 + inBody * 1.5
    }
    if (hits === 0) return 0
    const phrase = terms.join(' ')
    if (terms.length > 1) {
      if (title.includes(phrase)) score += 12
      if (body.includes(phrase)) score += 5
    }
    if (options.boosted === true) score += 4
  }
  score *= 0.7 + note.importance * 0.1
  if (note.pinned) score += 2
  score *= 0.6 + 0.4 * ageFactor(note.updated || note.created)
  return score
}

/** A short excerpt around the best match, or the note's opening lines. */
export function makeSnippet(note, terms, maxChars = 240) {
  const lines = note.body.split('\n')
  const meaningful = (line) => line.trim() !== '' && !line.trim().startsWith('#')
  let start = -1
  if (terms.length > 0) {
    const lowered = lines.map((line) => line.toLowerCase())
    for (let index = 0; index < lowered.length; index += 1) {
      if (terms.some((term) => lowered[index].includes(term))) {
        start = index
        break
      }
    }
  }
  if (start < 0) start = lines.findIndex(meaningful)
  if (start < 0) return ''

  const window = []
  for (let index = start; index < lines.length && window.length < 3; index += 1) {
    if (lines[index].trim() === '' && window.length > 0) break
    window.push(lines[index].trim())
  }
  let text = window.join(' ').replace(/\s+/g, ' ').trim()
  const startedMidway = start > 0 && terms.length > 0
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}…`
  }
  return startedMidway ? `…${text}` : text
}

/* ------------------------------------------------------------------ *
 * Duplicate detection
 * ------------------------------------------------------------------ */

function normalizeTitle(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokenSet(text) {
  return new Set(normalizeTitle(text).split(' ').filter((token) => token.length > 1))
}

function bigramSet(text) {
  const compact = normalizeTitle(text).replace(/ /g, '')
  const out = new Set()
  for (let index = 0; index < compact.length - 1; index += 1) out.add(compact.slice(index, index + 2))
  return out
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const value of left) if (right.has(value)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** How alike two titles are: shared words or near-identical wording both count. */
export function titleSimilarity(left, right) {
  const a = normalizeTitle(left)
  const b = normalizeTitle(right)
  if (a === '' || b === '') return 0
  if (a === b) return 1
  return Math.max(jaccard(tokenSet(a), tokenSet(b)), jaccard(bigramSet(a), bigramSet(b)))
}

const DUPLICATE_TITLE_THRESHOLD = 0.82
const DUPLICATE_TITLE_FLOOR = 0.6
const DUPLICATE_TAG_THRESHOLD = 0.5

/**
 * The existing note a save would duplicate, or undefined.
 * A near-identical title is enough; a merely similar one needs matching tags.
 */
export function findDuplicate(notes, candidate) {
  const wanted = new Set(
    (candidate.tags ?? [])
      .map((tag) => String(tag).toLowerCase().replace(/^#/, '').trim())
      .filter((tag) => tag !== ''),
  )
  let best
  for (const note of notes) {
    const title = titleSimilarity(note.title, candidate.title)
    if (title < DUPLICATE_TITLE_FLOOR) continue
    const overlap = jaccard(wanted, new Set(note.tags.map((tag) => tag.toLowerCase())))
    if (title < DUPLICATE_TITLE_THRESHOLD && overlap < DUPLICATE_TAG_THRESHOLD) continue
    // Rank by how strongly the pair matches; report title similarity, which is
    // the number a caller can act on.
    const rank = 0.75 * title + 0.25 * overlap
    if (best === undefined || rank > best.rank) {
      best = { note, rank, score: Math.round(title * 100) / 100, tagOverlap: Math.round(overlap * 100) / 100 }
    }
  }
  return best
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

/**
 * Create the memory store for one configuration.
 * `cli` is an optional Obsidian CLI bridge used for discovery and every
 * mutation, with a filesystem fallback so memory keeps working when the app is
 * closed.
 */
export function createStore(config, cli) {
  const memoryFolder = normalizeFolder(config.memoryFolder)
  let resolved

  async function vault() {
    if (resolved !== undefined && resolved.error === undefined) return resolved
    resolved = await discoverVault(config, cli)
    return resolved
  }

  async function requireVault() {
    const found = await vault()
    if (found.error !== undefined) {
      const error = new Error(found.error)
      error.code = 'MEMORY_NO_VAULT'
      throw error
    }
    return found
  }

  const rootOf = (found) => path.join(found.path, memoryFolder)

  function scopeFolder(scope, projectKey) {
    return scope === 'global' ? `${memoryFolder}/global` : `${memoryFolder}/projects/${projectKey}`
  }

  async function listScope(scope, projectKey) {
    const found = await requireVault()
    const folder = scopeFolder(scope, projectKey)
    const absolute = path.join(rootOf(found), scope === 'global' ? 'global' : `projects/${projectKey}`)
    let entries = []
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return []
    }
    const notes = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      const vaultRelative = `${folder}/${entry.name}`
      let text
      try {
        text = await fsp.readFile(path.join(absolute, entry.name), 'utf8')
      } catch {
        continue
      }
      notes.push(toNote(text, scope, vaultRelative))
    }
    return notes
  }

  async function allNotes(scopes, projectKey) {
    const collected = []
    for (const scope of scopes) {
      if (scope === 'project' && projectKey === '') continue
      collected.push(...(await listScope(scope, projectKey)))
    }
    return collected
  }

  async function findNote(idOrPath, projectKey) {
    const found = await requireVault()
    const cleaned = String(idOrPath ?? '').trim().replace(/^\/+/, '')
    if (cleaned === '') return { error: 'id is required' }

    if (cleaned.includes('/')) {
      const absolute = path.resolve(found.path, cleaned)
      const base = path.resolve(found.path)
      if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) {
        return { error: 'path escapes the vault' }
      }
      if (!absolute.toLowerCase().endsWith('.md')) return { error: 'not a markdown note' }
      try {
        const text = await fsp.readFile(absolute, 'utf8')
        const scope = cleaned.startsWith(`${memoryFolder}/projects/`) ? 'project' : 'global'
        return { note: toNote(text, scope, cleaned) }
      } catch {
        return { error: `no memory note at ${cleaned}` }
      }
    }

    const matches = []
    for (const scope of SCOPES) {
      for (const note of await listScope(scope, projectKey)) {
        if (note.id === cleaned) matches.push(note)
      }
    }
    if (matches.length === 0) return { error: `no memory note with id "${cleaned}"` }
    if (matches.length === 1) return { note: matches[0] }
    return {
      error: `id "${cleaned}" exists in more than one scope; pass one of these paths instead: ${matches.map((note) => note.path).join(', ')}`,
      candidates: matches.map((note) => note.path),
    }
  }

  async function uniqueId(folderAbsolute, base) {
    let candidate = base
    let suffix = 2
    for (;;) {
      const exists = await fsp
        .access(path.join(folderAbsolute, `${candidate}.md`))
        .then(() => true)
        .catch(() => false)
      if (!exists) return candidate
      candidate = `${base}-${suffix}`
      suffix += 1
      if (suffix > 50) return `${base}-${Date.now()}`
    }
  }

  async function writeViaFilesystem(found, vaultRelative, content) {
    const absolute = path.join(found.path, vaultRelative)
    await fsp.mkdir(path.dirname(absolute), { recursive: true })
    const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(temporary, content, 'utf8')
    await fsp.rename(temporary, absolute)
  }

  /**
   * Save one memory note. `cli` writes first (verified by reading the note
   * back) so Obsidian applies the write itself; the filesystem is the fallback.
   */
  async function save(input) {
    const found = await requireVault()
    const scope = input.scope === 'global' ? 'global' : 'project'
    const projectKey = input.projectKey ?? ''
    if (scope === 'project' && projectKey === '') {
      const error = new Error('project scope needs a project directory: no working directory was resolved for this session')
      error.code = 'MEMORY_NO_PROJECT'
      throw error
    }

    const folder = scopeFolder(scope, projectKey)
    const folderAbsolute = path.join(rootOf(found), scope === 'global' ? 'global' : `projects/${projectKey}`)
    const existing = input.id === undefined ? undefined : await findNote(input.id, projectKey)
    if (existing?.error !== undefined && existing.candidates !== undefined) return { error: existing.error }
    const previous = existing?.note

    const now = new Date()
    const isoDate = now.toISOString().slice(0, 10)
    const timestamp = now.toISOString()
    const title = String(input.title ?? '').trim()
    if (title === '') return { error: 'title is required' }

    if (previous === undefined && input.force !== true) {
      const duplicate = findDuplicate(await listScope(scope, projectKey), {
        title,
        tags: Array.isArray(input.tags) ? input.tags : [],
      })
      if (duplicate !== undefined) {
        return {
          error:
            `${scope} memory already holds this fact as "${duplicate.note.title}" ` +
            `(id ${duplicate.note.id}, ${duplicate.note.path}, similarity ${duplicate.score}). ` +
            'Pass that id to update the note, or force: true to keep a separate one.',
          duplicate: {
            id: duplicate.note.id,
            title: duplicate.note.title,
            path: duplicate.note.path,
            scope: duplicate.note.scope,
            score: duplicate.score,
            tagOverlap: duplicate.tagOverlap,
          },
        }
      }
    }

    const id = previous !== undefined
      ? previous.id
      : await uniqueId(folderAbsolute, `${isoDate}-${slugify(title) || 'memory'}`)
    const vaultRelative = previous !== undefined ? previous.path : `${folder}/${id}.md`

    const pinRequested = input.pinned ?? input.pin
    const note = {
      scope,
      project: scope === 'project' ? projectKey : '',
      title,
      tags: (Array.isArray(input.tags) ? input.tags : []).map((tag) => String(tag).replace(/^#/, '').trim()).filter((tag) => tag !== ''),
      importance: Math.min(5, Math.max(1, Math.round(Number(input.importance ?? previous?.importance ?? 3)))),
      pinned: pinRequested === undefined ? previous?.pinned === true : pinRequested === true,
      created: previous?.created !== undefined && previous.created !== '' ? previous.created : timestamp,
      updated: timestamp,
      body: String(input.content ?? '').trim(),
    }
    const content = serializeNote(note)

    let backend = 'filesystem'
    let cliError = ''
    if (cli !== undefined && config.preferCli === true) {
      const written = await cli.writeNote(vaultRelative, content)
      if (written.ok) backend = 'obsidian-cli'
      else cliError = written.reason
    }
    if (backend !== 'obsidian-cli') await writeViaFilesystem(found, vaultRelative, content)

    return {
      note: { ...note, id, path: vaultRelative, created: note.created, updated: note.updated.slice(0, 10) },
      created: previous === undefined,
      backend,
      cliError,
    }
  }

  async function recall(input) {
    const found = await requireVault()
    const projectKey = input.projectKey ?? ''
    const limit = Math.min(25, Math.max(1, Math.round(Number(input.limit ?? config.recallLimit ?? 8))))
    const requested = input.scope === 'global' || input.scope === 'project' ? [input.scope] : SCOPES
    const scopes = requested.filter((scope) => scope !== 'project' || projectKey !== '')
    const terms = queryTerms(input.query)
    const wantedTags = (Array.isArray(input.tags) ? input.tags : []).map((tag) => String(tag).replace(/^#/, '').toLowerCase().trim()).filter((tag) => tag !== '')

    let notes = await allNotes(scopes, projectKey)
    if (wantedTags.length > 0) {
      notes = notes.filter((note) => wantedTags.every((tag) => note.tags.some((have) => have.toLowerCase() === tag)))
    }

    // Obsidian's own search contributes candidates and a relevance boost when
    // the app is running; the ranking itself stays local and deterministic.
    let boosted = new Set()
    let searchBackend = 'filesystem'
    if (terms.length > 0 && cli !== undefined && config.preferCli === true) {
      const folder = scopes.length === 1 ? scopeFolder(scopes[0], projectKey) : memoryFolder
      const paths = await cli.searchPaths(String(input.query), folder, 50)
      if (paths !== undefined) {
        searchBackend = 'obsidian-cli'
        boosted = new Set(paths.map((entry) => entry.replace(/^\/+/, '')))
      }
    }

    const scored = notes
      .map((note) => ({ note, score: scoreNote(note, terms, { boosted: boosted.has(note.path) }) }))
      .filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || (b.note.updated || '').localeCompare(a.note.updated || ''))

    const results = scored.slice(0, limit).map(({ note, score }) => ({
      id: note.id,
      path: note.path,
      scope: note.scope,
      title: note.title,
      tags: note.tags,
      importance: note.importance,
      pinned: note.pinned,
      updated: note.updated,
      snippet: makeSnippet(note, terms),
      score: Math.round(score * 10) / 10,
    }))

    return {
      query: String(input.query ?? ''),
      results,
      total: scored.length,
      considered: notes.length,
      searchBackend,
      vault: found.path,
      projectKey,
    }
  }

  async function read(idOrPath, projectKey) {
    const found = await requireVault()
    const located = await findNote(idOrPath, projectKey)
    if (located.error !== undefined) return { error: located.error, candidates: located.candidates }
    const note = located.note
    const truncated = note.body.length > MAX_BODY_BYTES
    return {
      note: {
        ...note,
        content: truncated ? note.body.slice(0, MAX_BODY_BYTES) : note.body,
        truncated,
        absolutePath: path.join(found.path, note.path),
      },
    }
  }

  async function forget(idOrPath, projectKey, permanent) {
    const found = await requireVault()
    const located = await findNote(idOrPath, projectKey)
    if (located.error !== undefined) return { error: located.error, candidates: located.candidates }
    const note = located.note
    const absolute = path.join(found.path, note.path)

    if (permanent !== true && cli !== undefined && config.preferCli === true) {
      const removed = await cli.deleteNote(note.path)
      if (removed.ok) {
        const stillThere = await fsp
          .access(absolute)
          .then(() => true)
          .catch(() => false)
        // Obsidian sends a deleted note to its configured trash: the system trash
        // by default, the vault's own .trash when so configured. Both restore.
        if (!stillThere) return { note, deleted: true, backend: 'obsidian-cli', location: 'trash (restorable)' }
      }
    }

    if (permanent === true) {
      await fsp.rm(absolute, { force: true })
      return { note, deleted: true, backend: 'filesystem', location: 'permanently deleted' }
    }

    const trashAbsolute = path.join(found.path, memoryFolder, TRASH_DIR, note.id)
    await fsp.mkdir(path.dirname(trashAbsolute), { recursive: true })
    let target = `${trashAbsolute}.md`
    let suffix = 2
    for (;;) {
      const taken = await fsp
        .access(target)
        .then(() => true)
        .catch(() => false)
      if (!taken) break
      target = `${trashAbsolute}-${suffix}.md`
      suffix += 1
    }
    await fsp.rename(absolute, target)
    return { note, deleted: true, backend: 'filesystem', location: path.relative(found.path, target) }
  }

  async function status(projectKey) {
    const found = await vault()
    const probe = cli === undefined ? { available: false, version: '', reason: 'disabled' } : await cli.probe()
    if (found.error !== undefined) {
      return { error: found.error, vault: null, cli: probe, projectKey, counts: { global: 0, project: 0 } }
    }
    const globalNotes = await listScope('global', projectKey).catch(() => [])
    const projectNotes = projectKey === '' ? [] : await listScope('project', projectKey).catch(() => [])
    const summarize = (notes) => ({
      notes: notes.length,
      pinned: notes.filter((note) => note.pinned).length,
      newest: notes.map((note) => note.updated).filter((value) => value !== '').sort().at(-1) ?? '',
    })
    return {
      vault: found.path,
      vaultSource: found.source,
      memoryRoot: path.join(found.path, memoryFolder),
      memoryFolder,
      projectKey,
      cli: probe,
      preferCli: config.preferCli === true,
      counts: { global: summarize(globalNotes), project: summarize(projectNotes) },
    }
  }

  /** Pinned notes for the prompt: durable facts worth seeing without a tool call. */
  async function core(projectKey, maxBytes) {
    const found = await vault()
    if (found.error !== undefined) return { text: '', count: 0 }
    const globalNotes = (await listScope('global', projectKey).catch(() => [])).filter((note) => note.pinned)
    const projectNotes = projectKey === '' ? [] : (await listScope('project', projectKey).catch(() => [])).filter((note) => note.pinned)
    const sections = []
    let used = 0
    const budget = Math.max(500, Number(maxBytes) || 4000)
    const render = (label, notes) => {
      if (notes.length === 0) return
      const lines = [`### ${label}`]
      for (const note of notes.slice(0, 8)) {
        const body = note.body.length > 400 ? `${note.body.slice(0, 400).trimEnd()}…` : note.body
        const entry = `- **${note.title}** (${note.id})${note.tags.length > 0 ? ` #${note.tags.join(' #')}` : ''}\n  ${body.replace(/\n+/g, ' ')}`
        if (used + entry.length > budget) {
          lines.push('- …more pinned notes omitted')
          break
        }
        used += entry.length
        lines.push(entry)
      }
      sections.push(lines.join('\n'))
    }
    render('Global', globalNotes)
    render(`Project ${projectKey}`, projectNotes)
    if (sections.length === 0) return { text: '', count: 0 }
    return { text: sections.join('\n\n'), count: globalNotes.length + projectNotes.length }
  }

  return { vault, save, recall, read, forget, status, core, memoryFolder, scopeFolder }
}

function normalizeFolder(value) {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'DeepSeek Memory'
  return raw.replace(/^\/+/, '').replace(/\/+$/, '')
}
