# Obsidian Memory for DeepSeek Harness

Long-term memory for the agent, stored as ordinary markdown notes inside your
Obsidian vault, so you can read, edit, link, search, and sync it with the rest of
your notes.

No dependencies, no build step, no database: a DSH plugin bundle of plain Node ESM
modules plus two tests that run on a bare Node 20+.

## Install

Pick a source, then install the bundle into your profile.

**From npm** — `dsh-obsidian-memory` (available from its first published release):

```bash
dsh plugin --profile <name> add dsh-obsidian-memory
```

**From a clone** — works today, and is the path for unreleased changes:

```bash
git clone https://github.com/Goutam-11/dsh-obsidian-memory.git
dsh plugin --profile <name> add /path/to/dsh-obsidian-memory
```

Either way, also list `dsh-obsidian-memory` in the profile's `dsh.profile.bundles`
so the patch layer loads, or install through the Plugins page / by asking the
agent *"install the bundle dsh-obsidian-memory"*, which does both steps for you.

Then nothing else: the plugin finds the vault Obsidian has open, creates
`DeepSeek Memory/` on first save, and registers five tools. Set `vaultPath` in the
row config only when you want a vault other than the open one. Keep Obsidian
running so writes and deletes go through the CLI (see below); memory works either
way.

Verify with `memory_status`: it prints the resolved vault, the memory root, the
current project key, its source, note counts, and whether the CLI answered.

## What it does

Two scopes:

| Scope | Where it lives | Use it for |
| --- | --- | --- |
| `global` | `<vault>/DeepSeek Memory/global/` | preferences, habits, machine and tooling facts that hold in every project |
| `project` | `<vault>/DeepSeek Memory/projects/<project-key>/` | decisions, conventions, and gotchas belonging to one working directory |

`<project-key>` comes from the first of these that applies:

1. **A configured mapping** — `projectKeys: { "/path/prefix": "name" }`; the
   longest matching prefix wins.
2. **The git remote** — `owner-repo` derived from `remote.origin.url`, so moving
   or re-cloning a checkout keeps its notes (a directory anywhere inside the
   checkout maps to the same key).
3. **The folder name plus a path hash** — for directories that are not a git
   repository, e.g. `default-workspace-906c02`.

`memory_status` reports which of the three produced the key. Nothing migrates
automatically: if a key changes, the old project folder keeps its notes and the
new key starts empty.

## What the model gets

Five tools:

- `memory_save` — store one self-contained fact (title, content, scope, tags, importance, pin).
- `memory_recall` — ranked search across global and project notes; returns ids and snippets.
- `memory_read` — read one note in full before acting on it.
- `memory_forget` — remove a note; the CLI sends it to Obsidian's trash, so it stays restorable.
- `memory_status` — vault, memory root, per-scope counts, and CLI availability.

Two prompt sections:

1. **How to use memory** — when to recall, what is worth saving, what never to
   save (secrets, transient state). It also carries the three decision rules
   that keep the vault clean: recall before saving and update a note by `id`
   instead of creating a sibling, pick scope by reach (still true in another
   repo → `global`, only true here → `project`), and reuse the tags a recall
   shows rather than inventing new ones. These are always-on because they are
   decisions made *before* any tool call, which a loadable skill cannot cover.
2. **Pinned notes** — notes saved with `pin: true` are shown at the start of
   every turn, without a tool call. They are marked as *records, not
   instructions*, so nothing in a note can redirect the agent. The block is
   capped at `coreMaxBytes` characters per turn; set `injectCore: false` to
   drop it and rely on `memory_recall` alone.

## How the Obsidian CLI is used

The Obsidian CLI (Obsidian 1.12+, **Settings → General → Command line
interface**) talks to a running Obsidian app over a unix socket. This plugin
therefore treats the CLI as the preferred *writer* and the vault files as the
reader:

| Operation | Preferred | Fallback |
| --- | --- | --- |
| Find the vault | `obsidian.json` registry, then `obsidian vault info=path` | config `vaultPath` |
| Save / update a note | `obsidian create … overwrite`, then `obsidian read` to prove the note round-tripped | atomic file write (temp file + rename) |
| Delete a note | `obsidian delete`, verified by the file disappearing; Obsidian sends it to its configured trash (system trash by default), so it stays restorable | move to `DeepSeek Memory/.trash/` |
| Recall candidates | `obsidian search … format=json` when a query is given (ranked, extra weight for notes Obsidian matched) | local ranking over the vault files |
| Read / list / rank | vault files directly | — |

Reads use the files directly on purpose: they are byte-exact and they keep
memory usable while Obsidian is closed, which is the common case for an agent
running in a terminal. Writes are verified when they go through the CLI, because
the CLI carries content inside `key=value` arguments; if a write does not
round-trip, the plugin rewrites the note directly instead of leaving it
corrupted. `memory_status` reports which binary and version answered.

## Configuration

Settings live in this bundle's row config (the `obsidian-memory` entry in the
profile patch), which is where `install_bundle` writes them; the plugin ships its
defaults so it works with none of them set.

| Key | Default | Meaning |
| --- | --- | --- |
| `vault` | `""` | Vault name or id registered in Obsidian. Empty follows the vault Obsidian has open. |
| `vaultPath` | `""` | Absolute vault path; takes priority over `vault`. |
| `memoryFolder` | `DeepSeek Memory` | Folder for the notes, relative to the vault root. |
| `preferCli` | `true` | Write and delete through the CLI when reachable. |
| `obsidianBin` | `""` | CLI binary; empty searches `~/.local/bin/obsidian` and `PATH`. |
| `injectCore` | `true` | Show pinned notes at the start of every turn. |
| `coreMaxBytes` | `4000` | Character budget for those pinned notes. |
| `recallLimit` | `8` | Default number of recall results. |
| `projectKeys` | `{}` | Map of absolute path prefix to project key; overrides the git remote and the folder hash. |

### Saving: the duplicate guard

`memory_save` compares a new note against the notes already in the same scope
before writing. A title that normalises to an obvious near-match is refused with
the existing note's `id`, `title`, `path` and similarity score, so the caller
updates that note instead of creating a sibling. A merely similar title is only
refused when the tags also overlap; a genuinely different fact always saves.

Pass `force: true` to keep a deliberately separate note, and pass `id` to update
an existing one (updates are never blocked). Scopes are checked independently:
a global note does not block a project note with the same title.

## Note format

```markdown
---
title: "Prefers pnpm workspaces"
scope: project
tags: ["tooling", "packages"]
importance: 4
pinned: false
created: 2026-10-29T15:40:12.000Z
updated: 2026-10-29T15:40:12.000Z
project: default-workspace-3a19c8
---

Use pnpm with a shared lockfile here; npm installs break the workspace links.
```

Frontmatter is the only structure the plugin needs; the body is free markdown
and may contain links, headings, code blocks, and callouts.

## Requirements

- Obsidian 1.12+ with the CLI enabled, for the CLI write path. Without it the
  plugin still works through the vault files.
- The DSH process needs permission to read and write the vault directory.

## Tests

Both suites run on plain Node with no dependencies and use throwaway vaults in
`os.tmpdir()`:

```bash
node test/vault.test.mjs    # store: save, recall ranking, CJK, tags, trash, CLI/FS fallbacks
node test/plugin.test.mjs   # plugin: apply() with a stub Context, tool schemas, prompt sections
```

`plugin.test.mjs` pins the contract that a section's `text` function receives the
whole `AssembleContext`, so the `<memory_core>` project key must match the key the
tools compute.

## Troubleshooting

- **`Obsidian CLI: unavailable — The CLI is unable to find Obsidian`** — start
  Obsidian once; the CLI can only reach a running app. Memory keeps working
  through the filesystem meanwhile.
- **`no Obsidian vault found`** — set `vaultPath` in the plugin config.
- **Project notes missing** — the session has no working directory yet; run a
  command or set the working directory, then `memory_status` shows the key.

## Roadmap

The backlog lives in the issue tracker, one issue per proposed change, labelled by
area, size and priority:

- [Priority P1](https://github.com/Goutam-11/dsh-obsidian-memory/labels/priority%2FP1) — fix before recommending the plugin to others (duplicate guard, stable project keys, npm publish)
- [Priority P2](https://github.com/Goutam-11/dsh-obsidian-memory/labels/priority%2FP2) — next release
- [All open issues](https://github.com/Goutam-11/dsh-obsidian-memory/issues)

Each issue states the problem, the proposed approach, the files involved, and the
acceptance checks; work is expected to keep `npm test` green.

## Contributing

`main` is protected: changes land through a pull request, and the `test` workflow
(Node 20/22/24) must pass. There is no review requirement, so a solo change can
be merged as soon as CI is green.

1. Branch from `main`, make the smallest useful change, and add or update a check
   that fails without it — both suites are plain Node with no dependencies.
2. `npm test` locally; 31 store checks and 15 plugin checks currently pass.
3. Open a PR; the template asks for why, what changed, a diagram of the affected
   flow, and named evidence. Screenshots go in the UI proof section when the
   change is visible.
4. Squash merge. Merge commits and rebase merges are disabled, and the branch is
   deleted on merge, so history stays linear.

## Release

Publishing runs from CI, not from a laptop:

1. Bump `version` in `package.json` on a branch and merge it through a PR.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` checks that the tag matches `package.json`,
   runs `npm test`, and publishes with provenance.

It needs one repository secret, `NPM_TOKEN`: a granular npm token with publish
access to `dsh-obsidian-memory` (Settings → Secrets and variables → Actions).
Without it the workflow fails at the publish step; nothing else breaks.

A local `npm publish` also works (`prepublishOnly` runs the tests), and is the
fallback when CI secrets are unavailable.
