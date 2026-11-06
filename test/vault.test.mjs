/**
 * Smoke test for the memory store: runs entirely against a temporary vault in
 * the workspace, with and without a stubbed Obsidian CLI.
 *
 *   node test/vault.test.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore, projectKeyFor, parseFrontmatter } from '../lib/vault.js'

const tempRoot = path.join(os.tmpdir(), `dsh-obsidian-memory-${process.pid}-${Date.now()}`)
const vaultPath = path.join(tempRoot, 'Test Vault')
const projectDir = path.join(tempRoot, 'work', 'my-project')

const config = {
  vault: '',
  vaultPath,
  memoryFolder: 'DeepSeek Memory',
  preferCli: false,
  injectCore: true,
  coreMaxBytes: 4000,
  recallLimit: 8,
}

const projectKey = projectKeyFor(projectDir)
const store = createStore(config, undefined)

let passed = 0
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok ${passed} - ${name}`)
    })
    .catch((error) => {
      console.error(`not ok - ${name}\n${error.stack}`)
      process.exitCode = 1
      throw error
    })
}

const run = async () => {
  await fsp.mkdir(path.join(vaultPath, '.obsidian'), { recursive: true })

  await check('vault discovery uses the configured path', async () => {
    const found = await store.vault()
    assert.equal(found.error, undefined)
    assert.equal(found.path, vaultPath)
    assert.equal(found.source, 'config:vaultPath')
  })

  let globalNote
  await check('saves a global note with frontmatter', async () => {
    const saved = await store.save({
      scope: 'global',
      title: 'Prefers pnpm',
      content: 'Use pnpm workspaces; npm install breaks the links.',
      tags: ['tooling', '#packages'],
      importance: 4,
      projectKey,
    })
    assert.equal(saved.created, true)
    assert.equal(saved.backend, 'filesystem')
    globalNote = saved.note
    assert.match(globalNote.path, /^DeepSeek Memory\/global\/\d{4}-\d{2}-\d{2}-prefers-pnpm\.md$/)
    const text = await fsp.readFile(path.join(vaultPath, globalNote.path), 'utf8')
    const { data, body } = parseFrontmatter(text)
    assert.equal(data.title, 'Prefers pnpm')
    assert.deepEqual(data.tags, ['tooling', 'packages'])
    assert.equal(data.importance, 4)
    assert.equal(data.pinned, false)
    assert.match(body, /pnpm workspaces/)
  })

  let projectNote
  await check('saves a project note under the project key', async () => {
    const saved = await store.save({
      scope: 'project',
      title: 'Obsidian CLI socket location',
      content: 'The CLI socket sits at $XDG_RUNTIME_DIR/.obsidian-cli.sock and needs the app running.',
      tags: ['obsidian', 'cli'],
      importance: 5,
      pin: true,
      projectKey,
    })
    projectNote = saved.note
    assert.equal(projectNote.path, `DeepSeek Memory/projects/${projectKey}/${path.posix.basename(projectNote.path)}`)
    assert.equal(projectNote.pinned, true)
  })

  await check('project scope without a project key fails clearly', async () => {
    await assert.rejects(
      () => store.save({ scope: 'project', title: 'x', content: 'y', projectKey: '' }),
      /project scope needs a project directory/,
    )
  })

  await check('recall ranks by match and returns ids and snippets', async () => {
    const result = await store.recall({ query: 'pnpm', projectKey })
    assert.equal(result.searchBackend, 'filesystem')
    assert.equal(result.results.length, 1)
    assert.match(result.results[0].id, /prefers-pnpm$/)
    assert.equal(result.results[0].scope, 'global')
    assert.match(result.results[0].snippet, /pnpm/)
  })

  await check('recall finds both scopes and respects the scope filter', async () => {
    const all = await store.recall({ query: 'obsidian', projectKey })
    assert.ok(all.results.some((entry) => entry.scope === 'project'))
    const onlyGlobal = await store.recall({ query: 'obsidian', scope: 'global', projectKey })
    assert.equal(onlyGlobal.results.length, 0)
  })

  await check('recall without a query prefers important and pinned notes', async () => {
    const listed = await store.recall({ projectKey })
    assert.equal(listed.results[0].id, projectNote.id)
    assert.equal(listed.results[0].pinned, true)
  })

  await check('tag filtering is conjunctive', async () => {
    const hit = await store.recall({ tags: ['obsidian', 'cli'], projectKey })
    assert.equal(hit.results.length, 1)
    const miss = await store.recall({ tags: ['obsidian', 'nope'], projectKey })
    assert.equal(miss.results.length, 0)
  })

  await check('CJK text is searchable', async () => {
    await store.save({
      scope: 'global',
      title: '中文记忆',
      content: '用户偏好中文回复，长期记忆保存在 Obsidian 中。',
      projectKey,
    })
    const result = await store.recall({ query: '长期记忆', projectKey })
    assert.equal(result.results.length, 1)
    assert.match(result.results[0].snippet, /Obsidian/)
  })

  await check('updating by id keeps the original id and creation date', async () => {
    const updated = await store.save({
      id: globalNote.id,
      scope: 'global',
      title: 'Prefers pnpm',
      content: 'Use pnpm workspaces; npm install breaks the links. Always run pnpm -r build first.',
      projectKey,
    })
    assert.equal(updated.created, false)
    assert.equal(updated.note.id, globalNote.id)
    assert.equal(updated.note.created, globalNote.created)
    const read = await store.read(globalNote.id, projectKey)
    assert.match(read.note.content, /pnpm -r build/)
  })

  await check('duplicate titles get distinct ids', async () => {
    const first = await store.save({ scope: 'global', title: 'Same title', content: 'one', projectKey })
    const second = await store.save({ scope: 'global', title: 'Same title', content: 'two', projectKey })
    assert.notEqual(first.note.id, second.note.id)
    assert.match(second.note.id, /-2$/)
  })

  await check('core returns pinned notes and truncates to the budget', async () => {
    const core = await store.core(projectKey, 4000)
    assert.match(core.text, /Global|Project/)
    assert.match(core.text, /Obsidian CLI socket/)
    const tiny = await store.core(projectKey, 500)
    assert.ok(tiny.text.length <= 900)
  })

  await check('status reports counts and CLI availability', async () => {
    const status = await store.status(projectKey)
    assert.equal(status.vault, vaultPath)
    assert.ok(status.counts.global.notes >= 4)
    assert.equal(status.counts.project.notes, 1)
    assert.equal(status.counts.project.pinned, 1)
    assert.equal(status.cli.available, false)
  })

  await check('read rejects a path outside the vault', async () => {
    const read = await store.read('../../etc/passwd', projectKey)
    assert.match(String(read.error), /markdown note|escapes the vault/)
  })

  await check('forget moves the note to the vault trash', async () => {
    const removed = await store.forget(globalNote.id, projectKey)
    assert.equal(removed.deleted, true)
    assert.equal(removed.backend, 'filesystem')
    assert.match(removed.location, /DeepSeek Memory\/\.trash\//)
    const again = await store.read(globalNote.id, projectKey)
    assert.match(String(again.error), /no memory note/)
  })

  await check('project keys differ per directory and stay stable', async () => {
    assert.equal(projectKeyFor(projectDir), projectKey)
    assert.notEqual(projectKeyFor(path.join(tempRoot, 'work', 'other')), projectKey)
    assert.match(projectKey, /^my-project-[0-9a-f]{6}$/)
  })

  // --- CLI path -------------------------------------------------------
  const written = []
  const fakeCli = {
    probe: async () => ({ available: true, version: '1.14.5', reason: '' }),
    vaultPath: async () => vaultPath,
    writeNote: async (vaultRelative, content) => {
      written.push(vaultRelative)
      const absolute = path.join(vaultPath, vaultRelative)
      await fsp.mkdir(path.dirname(absolute), { recursive: true })
      await fsp.writeFile(absolute, content, 'utf8')
      return { ok: true, reason: '' }
    },
    deleteNote: async (vaultRelative) => {
      await fsp.rm(path.join(vaultPath, vaultRelative), { force: true })
      return { ok: true, reason: '' }
    },
    searchPaths: async () => [`DeepSeek Memory/projects/${projectKey}/${projectNote.id}.md`],
  }
  const cliStore = createStore({ ...config, preferCli: true }, fakeCli)

  await check('writes go through the CLI when it is available', async () => {
    const saved = await cliStore.save({ scope: 'global', title: 'CLI write', content: 'through the cli', projectKey })
    assert.equal(saved.backend, 'obsidian-cli')
    assert.ok(written.some((entry) => entry.endsWith('cli-write.md')))
  })

  await check('a failing CLI write falls back to the filesystem', async () => {
    const failing = createStore(
      { ...config, preferCli: true },
      { ...fakeCli, writeNote: async () => ({ ok: false, reason: 'app not running' }) },
    )
    const saved = await failing.save({ scope: 'global', title: 'Fallback write', content: 'x', projectKey })
    assert.equal(saved.backend, 'filesystem')
    assert.equal(saved.cliError, 'app not running')
  })

  await check('CLI search marks the backend and boosts its candidates', async () => {
    const result = await cliStore.recall({ query: 'obsidian', projectKey })
    assert.equal(result.searchBackend, 'obsidian-cli')
    assert.ok(result.results.some((entry) => entry.scope === 'project'))
  })

  await check('forget uses the CLI trash path first', async () => {
    const removed = await cliStore.forget(projectNote.id, projectKey)
    assert.equal(removed.backend, 'obsidian-cli')
    assert.equal(removed.location, 'trash (restorable)')
  })

  await fsp.rm(tempRoot, { recursive: true, force: true })
  console.log(`\n${passed} checks passed`)
}

run().catch(async (error) => {
  await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  console.error(error)
  process.exitCode = 1
})
