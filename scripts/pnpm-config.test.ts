// Static checks for the pnpm settings: pnpm 10, 11 and 12 must all install without `pnpm approve-builds`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (rel: string) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')

interface Workspace {
  lists: Record<string, string[]>
  maps: Record<string, Record<string, string>>
}

const unquote = (s: string) => s.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')

/** Reads the small YAML subset pnpm-workspace.yaml uses: top-level keys holding a list or a map. */
function parseWorkspace(text: string): Workspace {
  const ws: Workspace = { lists: {}, maps: {} }
  let key: string | null = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const top = /^([\w-]+):\s*$/.exec(line)
    const item = /^\s+-\s+(\S.*?)\s*$/.exec(line)
    const pair = /^\s+(\S.*?):\s+(\S.*?)\s*$/.exec(line)
    if (top) key = top[1]
    else if (key && item) (ws.lists[key] ??= []).push(unquote(item[1]))
    else if (key && pair) (ws.maps[key] ??= {})[unquote(pair[1])] = unquote(pair[2])
    else throw new Error(`pnpm-workspace.yaml: line this test cannot read: ${line}`)
  }
  return ws
}

/** Installed dependencies with a script pnpm only runs when the build is approved. */
function installedWithInstallScripts(store: string): Set<string> {
  const names = new Set<string>()
  for (const entry of fs.readdirSync(store)) {
    const modules = path.join(store, entry, 'node_modules')
    if (entry.startsWith('.') || entry === 'node_modules' || !fs.existsSync(modules)) continue
    const dirs: string[] = []
    for (const name of fs.readdirSync(modules)) {
      if (name.startsWith('@')) dirs.push(...fs.readdirSync(path.join(modules, name)).map(n => `${name}/${n}`))
      else dirs.push(name)
    }
    for (const dir of dirs) {
      const pkgDir = path.join(modules, ...dir.split('/'))
      // The package itself is a real folder; its dependencies next to it are symlinks.
      if (fs.lstatSync(pkgDir).isSymbolicLink()) continue
      let pkg: { name?: string, scripts?: Record<string, string> }
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
      }
      catch {
        continue
      }
      const scripts = pkg.scripts ?? {}
      if (scripts.preinstall || scripts.install || scripts.postinstall || fs.existsSync(path.join(pkgDir, 'binding.gyp'))) {
        names.add(pkg.name ?? dir)
      }
    }
  }
  return names
}

describe('package.json', () => {
  it('has no "pnpm" field (pnpm 11 and later ignore it and warn)', () => {
    expect(JSON.parse(read('package.json'))).not.toHaveProperty('pnpm')
  })
})

describe('pnpm-workspace.yaml', () => {
  const ws = parseWorkspace(read('pnpm-workspace.yaml'))
  const allowBuilds = ws.maps.allowBuilds ?? {}
  const onlyBuilt = ws.lists.onlyBuiltDependencies ?? []

  it('declares the single package, which pnpm 9 and 10.0–10.4 require', () => {
    expect(ws.lists.packages).toEqual(['.'])
  })

  it('approves the esbuild and vue-demi install scripts under both keys', () => {
    expect(allowBuilds).toMatchObject({ 'esbuild': 'true', 'vue-demi': 'true' })
    expect(onlyBuilt).toEqual(expect.arrayContaining(['esbuild', 'vue-demi']))
  })

  it('keeps allowBuilds (pnpm 10.26+, 11, 12) and onlyBuiltDependencies (pnpm 10.5–10.25) in sync', () => {
    for (const [name, value] of Object.entries(allowBuilds)) expect(['true', 'false'], name).toContain(value)
    const approved = Object.keys(allowBuilds).filter(name => allowBuilds[name] === 'true')
    expect([...onlyBuilt].sort()).toEqual(approved.sort())
  })

  it('has no placeholder that an interactive pnpm 11+ install adds', () => {
    expect(read('pnpm-workspace.yaml')).not.toMatch(/set this to true or false/)
  })

  const store = path.join(root, 'node_modules', '.pnpm')
  it.skipIf(!fs.existsSync(store))('decides on every installed dependency with an install script (pnpm 11+ fails the install otherwise)', () => {
    const undecided = [...installedWithInstallScripts(store)].filter(name => !(name in allowBuilds))
    expect(undecided).toEqual([])
  })
})
