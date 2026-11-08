import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  commandSpec,
  compareVersions,
  isMain,
  lastLine,
  nodeProblem,
  nodeVersionOk,
  parseVersion,
  projectRoot,
  runCommand,
} from './lib/common.mjs'

describe('projectRoot', () => {
  it('is the folder above scripts/', () => {
    expect(path.basename(path.join(projectRoot, 'scripts'))).toBe('scripts')
    expect(projectRoot).toBe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
  })
})

describe('isMain', () => {
  const file = path.join(projectRoot, 'scripts', 'doctor.mjs')
  it('matches the script node was started with', () => {
    expect(isMain(pathToFileURL(file).href, file)).toBe(true)
    expect(isMain(pathToFileURL(file).href, path.relative(process.cwd(), file))).toBe(true)
  })
  it('is false for other scripts or no argv[1]', () => {
    expect(isMain(pathToFileURL(file).href, path.join(projectRoot, 'scripts', 'start.mjs'))).toBe(false)
    expect(isMain(pathToFileURL(file).href, undefined)).toBe(false)
  })
})

describe('parseVersion / compareVersions', () => {
  it('parses common version strings', () => {
    expect(parseVersion('v22.12.0')).toEqual([22, 12, 0])
    expect(parseVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright')).toEqual([6, 1, 1])
    expect(parseVersion('uv 0.9.5 (abc 2025-10-01)')).toEqual([0, 9, 5])
    expect(parseVersion('7.1-full_build-www.gyan.dev')).toEqual([7, 1, 0])
    expect(parseVersion('n/a')).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })

  it('compares numerically, not lexically', () => {
    expect(compareVersions('22.12.0', '22.12.0')).toBe(0)
    expect(compareVersions('22.9.0', '22.12.0')).toBe(-1)
    expect(compareVersions('v24.1.0', '22.12.0')).toBe(1)
    expect(compareVersions('22.12.1', '22.12')).toBe(1)
    expect(compareVersions('garbage', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', 'garbage')).toBe(1)
  })

  it('requires Node 22.12 or newer', () => {
    expect(nodeVersionOk('22.11.9')).toBe(false)
    expect(nodeVersionOk('22.12.0')).toBe(true)
    expect(nodeVersionOk('24.0.0')).toBe(true)
    expect(nodeVersionOk('20.18.0')).toBe(false)
  })
})

describe('nodeProblem', () => {
  it('explains an old Node in Chinese', async () => {
    expect(await nodeProblem('20.0.0', async () => true)).toMatch(/版本太舊/)
  })
  it('explains a Node without node:sqlite', async () => {
    expect(await nodeProblem('22.12.0', async () => false)).toMatch(/node:sqlite/)
  })
  it('accepts the running Node', async () => {
    expect(await nodeProblem()).toBeNull()
  })
})

describe('commandSpec', () => {
  it('spawns directly outside Windows', () => {
    expect(commandSpec('pnpm', ['install'], 'linux')).toEqual({ command: 'pnpm', args: ['install'], shell: false })
  })
  it('uses a fixed shell string for Windows .cmd shims', () => {
    expect(commandSpec('pnpm', ['build'], 'win32')).toEqual({ command: 'pnpm build', args: [], shell: true })
    expect(commandSpec('npm', ['install', '-g', 'pnpm@10'], 'win32').command).toBe('npm install -g pnpm@10')
  })
  it('keeps real executables shell-free on Windows', () => {
    expect(commandSpec('ffmpeg', ['-i', 'a & b.mp4'], 'win32')).toEqual({ command: 'ffmpeg', args: ['-i', 'a & b.mp4'], shell: false })
  })
  it('refuses shell metacharacters for shims', () => {
    expect(() => commandSpec('pnpm', ['install & calc'], 'win32')).toThrow(/Unsafe/)
    expect(() => commandSpec('pnpm', ['a|b'], 'win32')).toThrow(/Unsafe/)
  })
})

describe('runCommand', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const r = await runCommand(process.execPath, ['-e', 'console.log("hi 中文"); console.error("warn"); process.exit(3)'])
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
    expect(r.stdout.trim()).toBe('hi 中文')
    expect(r.stderr.trim()).toBe('warn')
    expect(r.notFound).toBe(false)
  })

  it('reports success', async () => {
    const r = await runCommand(process.execPath, ['--version'])
    expect(r.ok).toBe(true)
    expect(r.stdout.trim()).toBe(process.version)
  })

  it('flags a missing command', async () => {
    const r = await runCommand('gg-definitely-not-installed-xyz', ['--version'])
    expect(r.ok).toBe(false)
    expect(r.notFound).toBe(true)
  })

  it('kills a command that runs too long', async () => {
    const started = Date.now()
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 })
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('lastLine', () => {
  it('returns the last non-empty line, shortened', () => {
    expect(lastLine('a\r\nb\n\n')).toBe('b')
    expect(lastLine('')).toBe('')
    expect(lastLine('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})
