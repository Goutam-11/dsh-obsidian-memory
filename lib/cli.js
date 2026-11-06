/**
 * Obsidian CLI bridge.
 *
 * The Obsidian CLI (shipped with Obsidian 1.12+) talks to a *running* Obsidian
 * app over a unix socket, so every call is best-effort: the bridge reports its
 * own availability and the caller falls back to plain vault file access.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const CALL_TIMEOUT_MS = 10_000
const PROBE_TTL_MS = 15_000
const MAX_BUFFER = 8 * 1024 * 1024

/** Binary locations tried in order, so a DSH process without ~/.local/bin on PATH still finds the CLI. */
export function candidateBins(configured) {
  const list = []
  if (typeof configured === 'string' && configured.trim() !== '') {
    const value = configured.trim()
    // A bare name is resolved through PATH; anything with a separator is used as-is.
    list.push(value)
    if (value.startsWith('~/')) list.push(path.join(os.homedir(), value.slice(2)))
  }
  list.push(path.join(os.homedir(), '.local/bin/obsidian'))
  list.push('obsidian')
  list.push('/usr/local/bin/obsidian')
  list.push('/usr/bin/obsidian')
  return [...new Set(list)]
}

function execFileText(bin, args) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: CALL_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        // The CLI needs the user's runtime dir (unix socket) and locale.
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          reason: error === null ? '' : describeFailure(error, stderr),
        })
      },
    )
  })
}

function describeFailure(error, stderr) {
  const text = String(stderr ?? '').trim()
  if (text !== '') return text.split('\n')[0].trim()
  if (error?.code === 'ENOENT') return 'obsidian CLI not found'
  if (error?.killed) return 'obsidian CLI timed out'
  return String(error?.message ?? 'obsidian CLI failed').split('\n')[0].trim()
}

/**
 * Encode one `parameter=value` argument.
 *
 * The CLI documents `\n` and `\t` escapes for multiline values. Callers verify
 * every write by reading it back, so an imperfect escape degrades to the
 * filesystem path instead of corrupting a memory note.
 */
export function encodeParam(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/** Parse the CLI's JSON output, tolerating a leading log line before the document. */
function parseJson(text) {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    if (start < 0) return undefined
    try {
      return JSON.parse(trimmed.slice(start))
    } catch {
      return undefined
    }
  }
}

/** Paths from `search format=json`, whose exact element shape is not guaranteed. */
function pathsFromSearchJson(value) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.files) ? value.files : []
  const out = []
  for (const item of items) {
    if (typeof item === 'string') out.push(item)
    else if (item && typeof item === 'object') {
      const candidate = item.path ?? item.file ?? item.name
      if (typeof candidate === 'string') out.push(candidate)
    }
  }
  return out
}

/** Parse `search:context` text output: `path:line: text`. */
function parseContextText(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') continue
    const match = /^(.*):(\d+):\s?(.*)$/.exec(line)
    if (match === null) continue
    out.push({ path: match[1], line: Number(match[2]), text: match[3] })
  }
  return out
}

/**
 * Create a bridge bound to one configuration. Every method resolves with a
 * result object instead of throwing: an unavailable Obsidian is normal.
 */
export function createCliBridge(options = {}) {
  const bins = candidateBins(options.bin)
  let state = { at: 0, bin: '', version: '', available: false, reason: 'not probed' }

  function vaultArgs(args) {
    const vault = typeof options.vaultName === 'string' && options.vaultName !== '' ? options.vaultName : ''
    return vault === '' ? args : [`vault=${vault}`, ...args]
  }

  async function probe(force = false) {
    const now = Date.now()
    if (!force && now - state.at < PROBE_TTL_MS) return state
    let firstReason = ''
    for (const bin of bins) {
      const result = await execFileText(bin, ['version'])
      const version = result.stdout.trim().split('\n')[0].trim()
      if (result.ok && /^\d+\.\d+/.test(version)) {
        state = { at: now, bin, version, available: true, reason: '' }
        return state
      }
      if (firstReason === '' && result.reason !== '') firstReason = result.reason
    }
    state = { at: now, bin: '', version: '', available: false, reason: firstReason || 'obsidian CLI unavailable' }
    return state
  }

  /** Run one vault-scoped CLI command, probing first. */
  async function run(args) {
    const probeState = await probe()
    if (!probeState.available) return { ok: false, stdout: '', stderr: '', reason: probeState.reason }
    const result = await execFileText(probeState.bin, vaultArgs(args))
    if (!result.ok) state = { ...state, at: 0, available: false, reason: result.reason }
    return result
  }

  async function readNote(vaultRelativePath) {
    const result = await run(['read', `path=${encodeParam(vaultRelativePath)}`])
    if (!result.ok) return { ok: false, text: '', reason: result.reason }
    return { ok: true, text: result.stdout }
  }

  async function writeNote(vaultRelativePath, content) {
    const result = await run([
      'create',
      `path=${encodeParam(vaultRelativePath)}`,
      `content=${encodeParam(content)}`,
      'overwrite',
    ])
    if (!result.ok) return { ok: false, reason: result.reason }
    // The CLI's escaping is documented but not byte-exact for every payload:
    // confirm the note round-trips before trusting it.
    const check = await readNote(vaultRelativePath)
    if (!check.ok) return { ok: false, reason: `write not verified (${check.reason})` }
    const expected = normalizeText(content)
    const actual = normalizeText(check.text)
    if (expected !== actual) return { ok: false, reason: 'write did not round-trip through the CLI' }
    return { ok: true, reason: '' }
  }

  async function deleteNote(vaultRelativePath) {
    const result = await run(['delete', `path=${encodeParam(vaultRelativePath)}`])
    if (!result.ok) return { ok: false, reason: result.reason }
    return { ok: true, reason: '' }
  }

  /** Vault-relative paths matching a text query, or `undefined` when the CLI cannot answer. */
  async function searchPaths(query, folder, limit) {
    const scoped = ['search', `query=${encodeParam(query)}`, `limit=${limit}`, 'format=json']
    if (typeof folder === 'string' && folder !== '') scoped.push(`path=${encodeParam(folder)}`)
    const json = await run(scoped)
    if (json.ok) {
      const parsed = pathsFromSearchJson(parseJson(json.stdout))
      if (parsed.length > 0) return parsed
      if (json.stdout.trim() !== '') return []
    }
    const context = await run([
      'search:context',
      `query=${encodeParam(query)}`,
      `limit=${limit}`,
      ...(typeof folder === 'string' && folder !== '' ? [`path=${encodeParam(folder)}`] : []),
    ])
    if (!context.ok) return undefined
    const seen = []
    for (const hit of parseContextText(context.stdout)) {
      if (!seen.includes(hit.path)) seen.push(hit.path)
      if (seen.length >= limit) break
    }
    return seen
  }

  /** Vault-relative markdown paths under one folder, or `undefined` when unavailable. */
  async function listFiles(folder) {
    const result = await run(['files', `folder=${encodeParam(folder)}`, 'ext=md'])
    if (!result.ok) return undefined
    const out = []
    for (const raw of result.stdout.split('\n')) {
      const line = raw.trim()
      if (line === '' || line.endsWith('/')) continue
      if (!line.toLowerCase().endsWith('.md')) continue
      out.push(line)
    }
    return out
  }

  async function vaultPath() {
    const result = await run(['vault', 'info=path'])
    if (!result.ok) return undefined
    const value = result.stdout.trim().split('\n')[0].trim()
    return value === '' ? undefined : value
  }

  return {
    probe,
    invalidate: () => {
      state = { ...state, at: 0 }
    },
    readNote,
    writeNote,
    deleteNote,
    searchPaths,
    listFiles,
    vaultPath,
    state: () => state,
  }
}

/** Compare CLI output to written text without tripping over trailing newlines. */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
}
