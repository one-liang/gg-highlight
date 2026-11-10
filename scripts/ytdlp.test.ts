import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  ensure,
  ensurePlan,
  failureReason,
  hasCustomCommand,
  install,
  INSTALL_ARGS,
  installedVersion,
  main,
  readStamp,
  REINSTALL_ARGS,
  runProcess,
  UPGRADE_ARGS,
  upgradedVersions,
  uvEnv,
  uvErrorLine,
  VERSION_TIMEOUT_MS,
  ytdlpPaths,
} from './ytdlp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

interface RunResult { ok: boolean, code: number | null, stdout: string, stderr: string, notFound: boolean, timedOut: boolean, error: string | null }
interface Call { command: string, args: string[], opts: { cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number } }

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, code: 0, stdout, stderr, notFound: false, timedOut: false, error: null }
}
function failed(stderr = '', code = 2): RunResult {
  return { ok: false, code, stdout: '', stderr, notFound: false, timedOut: false, error: null }
}
const missing: RunResult = { ok: false, code: null, stdout: '', stderr: '', notFound: true, timedOut: false, error: 'spawn uv ENOENT' }
const timedOut: RunResult = { ok: false, code: null, stdout: '', stderr: '', notFound: false, timedOut: true, error: 'timeout' }

const INSTALL_OUTPUT = [
  'Resolved 12 packages in 806ms',
  'Installed 12 packages in 3.14s',
  ' + deno==2.9.8',
  ' + yt-dlp==2026.10.26',
  ' + yt-dlp-ejs==0.8.0',
  'Installed 1 executable: yt-dlp',
  'warning: `C:\\gg\\tools\\bin` is not on your PATH.',
].join('\n')
const UPDATED_OUTPUT = 'Updated yt-dlp v2026.10.21 -> v2026.10.26\n - yt-dlp==2026.10.21\n + yt-dlp==2026.10.26\nInstalled 1 executable: yt-dlp\n'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-ytdlp-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const paths = () => ytdlpPaths(tmp, 'linux')
const NOW = Date.parse('2026-11-10T12:00:00.000Z')

async function putExe() {
  await fs.mkdir(paths().binDir, { recursive: true })
  await fs.writeFile(paths().exe, '#!/bin/sh\n')
}
async function putStamp(time: number | string) {
  await fs.mkdir(paths().toolsDir, { recursive: true })
  await fs.writeFile(paths().stamp, typeof time === 'number' ? `${new Date(time).toISOString()}\n` : time)
}

/**
 * Fake uv: records calls and answers from a queue. `createExe` makes a successful install drop the
 * executable, like uv does. `yt-dlp --version` runs answer from `versions` (default: it works) and are
 * recorded in `checks`, not in `calls`.
 */
function fakeUv(results: RunResult[], { createExe = true, versions = [] as RunResult[] } = {}) {
  const calls: Call[] = []
  const checks: Call[] = []
  const run = async (command: string, args: string[], opts: Call['opts']) => {
    if (command === paths().exe) {
      checks.push({ command, args, opts })
      return versions.shift() ?? ok('2026.10.26\n')
    }
    calls.push({ command, args, opts })
    const result = results.shift() ?? missing
    if (createExe && result.ok && args[1] === 'install') await putExe()
    return result
  }
  return { run, calls, checks }
}

function opts(run: unknown, extra: Record<string, unknown> = {}) {
  const lines: string[] = []
  return {
    lines,
    options: { root: tmp, env: {}, platform: 'linux' as NodeJS.Platform, now: () => NOW, run, log: (msg: string) => lines.push(msg), ...extra },
  }
}

describe('paths and environment', () => {
  it('keeps everything under tools/, with yt-dlp.exe on Windows', () => {
    const p = ytdlpPaths('/gg', 'linux')
    expect(p).toEqual({
      toolsDir: path.join('/gg', 'tools'),
      uvToolDir: path.join('/gg', 'tools', 'uv'),
      binDir: path.join('/gg', 'tools', 'bin'),
      exe: path.join('/gg', 'tools', 'bin', 'yt-dlp'),
      stamp: path.join('/gg', 'tools', '.yt-dlp-checked'),
    })
    expect(path.basename(ytdlpPaths('/gg', 'win32').exe)).toBe('yt-dlp.exe')
  })

  it('points uv at tools/ and keeps the rest of the environment (proxy, certificates)', () => {
    const env = uvEnv('/gg', { PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', UV_TOOL_DIR: '/elsewhere' }, 'linux')
    expect(env).toEqual({
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy:8080',
      UV_TOOL_DIR: path.join('/gg', 'tools', 'uv'),
      UV_TOOL_BIN_DIR: path.join('/gg', 'tools', 'bin'),
    })
  })

  it('treats a blank GG_YTDLP_CMD as unset', () => {
    expect(hasCustomCommand({})).toBe(false)
    expect(hasCustomCommand({ GG_YTDLP_CMD: '  ' })).toBe(false)
    expect(hasCustomCommand({ GG_YTDLP_CMD: 'node fake-yt-dlp.mjs' })).toBe(true)
  })

  it('installs the requirement with the default and deno extras, and upgrades by name', () => {
    // --force: tools/bin belongs to the app, an executable uv has no record of there is overwritten.
    expect(INSTALL_ARGS).toEqual(['tool', 'install', '--upgrade', '--force', 'yt-dlp[default,deno]'])
    expect(REINSTALL_ARGS).toEqual(['tool', 'install', '--reinstall', '--force', 'yt-dlp[default,deno]'])
    expect(UPGRADE_ARGS).toEqual(['tool', 'upgrade', 'yt-dlp'])
  })
})

describe('reading uv output', () => {
  it('finds the installed and upgraded versions', () => {
    expect(installedVersion(INSTALL_OUTPUT)).toBe('2026.10.26')
    expect(installedVersion('Nothing to upgrade')).toBeNull()
    expect(upgradedVersions(UPDATED_OUTPUT)).toEqual(['2026.10.21', '2026.10.26'])
    expect(upgradedVersions('Nothing to upgrade\n')).toBeNull()
  })

  it('picks the line that names the error', () => {
    expect(uvErrorLine('warning: x is deprecated\nerror: Failed to upgrade yt-dlp\n  Caused by: Failed to fetch: `https://pypi.org/simple/yt-dlp/`\n'))
      .toBe('Failed to fetch: `https://pypi.org/simple/yt-dlp/`')
    expect(uvErrorLine('warning: deprecated\nerror: No solution found\n')).toBe('No solution found')
    expect(uvErrorLine('something odd\nwarning: deprecated\n')).toBe('something odd')
    expect(uvErrorLine('')).toBe('')
  })

  it('explains failures in Chinese', () => {
    expect(failureReason(missing)).toBe('找不到 uv，請重新執行 setup.bat')
    expect(failureReason(timedOut, 180_000)).toMatch(/^uv 超過 180 秒沒有完成.*下次啟動會再試$/)
    expect(failureReason(failed('error: No solution found'))).toBe('uv 執行失敗：No solution found')
    expect(failureReason(failed(''))).toBe('uv 執行失敗：結束代碼 2')
  })
})

describe('ensurePlan', () => {
  const plan = (extra: Record<string, unknown> = {}) => ensurePlan({ root: tmp, env: {}, platform: 'linux', now: () => NOW, ...extra })

  it('skips with GG_YTDLP_CMD, installs without the executable', async () => {
    expect(await plan({ env: { GG_YTDLP_CMD: 'fake' } })).toBe('skip')
    expect(await plan()).toBe('install')
    await putStamp(NOW)
    expect(await plan()).toBe('install') // a fresh stamp does not stand in for the executable
  })

  it('upgrades without a stamp, with a stale, unreadable or future stamp; nothing when fresh', async () => {
    await putExe()
    expect(await plan()).toBe('upgrade')
    await putStamp(NOW - CHECK_INTERVAL_MS - 1000)
    expect(await plan()).toBe('upgrade')
    await putStamp('not a date')
    expect(await plan()).toBe('upgrade')
    await putStamp(NOW + 60 * 60_000)
    expect(await plan()).toBe('upgrade')
    await putStamp(NOW - CHECK_INTERVAL_MS + 60_000)
    expect(await plan()).toBe('none')
  })
})

describe('ensure', () => {
  it('does nothing when GG_YTDLP_CMD is set, even without an executable', async () => {
    const uv = fakeUv([])
    const { options, lines } = opts(uv.run, { env: { GG_YTDLP_CMD: 'node fake.mjs' } })
    expect(await ensure(options)).toEqual({ ok: true, action: 'skipped', message: expect.stringContaining('GG_YTDLP_CMD') })
    expect(uv.calls).toEqual([])
    expect(lines).toEqual([])
  })

  it('installs into tools/ when the executable is missing, then writes the stamp', async () => {
    const uv = fakeUv([ok('', INSTALL_OUTPUT)])
    const { options, lines } = opts(uv.run)
    const result = await ensure(options)
    expect(result).toEqual({ ok: true, action: 'installed', message: '已安裝 yt-dlp 2026.10.26' })
    expect(uv.calls).toHaveLength(1)
    const [call] = uv.calls
    expect(call.command).toBe('uv')
    expect(call.args).toEqual(INSTALL_ARGS)
    expect(call.opts).toMatchObject({ cwd: tmp, timeoutMs: 600_000 })
    expect(call.opts.env).toMatchObject({ UV_TOOL_DIR: paths().uvToolDir, UV_TOOL_BIN_DIR: paths().binDir })
    expect(await readStamp(paths().stamp)).toBe(NOW)
    expect(await fs.readFile(paths().stamp, 'utf8')).toBe('2026-11-10T12:00:00.000Z\n')
    expect(lines[0]).toMatch(/^▶ 安裝 yt-dlp/)
    expect(lines.at(-1)).toBe('✅ 已安裝 yt-dlp 2026.10.26')
  })

  it('upgrades when the stamp is older than 24 hours', async () => {
    await putExe()
    await putStamp(NOW - CHECK_INTERVAL_MS - 1)
    const uv = fakeUv([ok('', UPDATED_OUTPUT)])
    const { options, lines } = opts(uv.run)
    expect(await ensure(options)).toEqual({ ok: true, action: 'upgraded', message: '已更新 yt-dlp（2026.10.21 → 2026.10.26）' })
    expect(uv.calls.map(c => c.args)).toEqual([UPGRADE_ARGS])
    expect(await readStamp(paths().stamp)).toBe(NOW)
    expect(lines).toEqual(['▶ 檢查 yt-dlp 更新…', '✅ 已更新 yt-dlp（2026.10.21 → 2026.10.26）'])
  })

  it('upgrades when the server deleted the stamp, and says when there was nothing new', async () => {
    await putExe()
    const uv = fakeUv([ok('', 'Nothing to upgrade\n')])
    const { options } = opts(uv.run)
    expect(await ensure(options)).toEqual({ ok: true, action: 'upgraded', message: 'yt-dlp 已是最新版' })
    expect(await readStamp(paths().stamp)).toBe(NOW)
  })

  it('a scheduled upgrade (stale stamp) does not run yt-dlp; one the server asked for (no stamp) checks it runs', async () => {
    await putExe()
    await putStamp(NOW - CHECK_INTERVAL_MS - 1)
    const scheduled = fakeUv([ok('', 'Nothing to upgrade\n')])
    await ensure(opts(scheduled.run).options)
    expect(scheduled.checks).toEqual([])

    await fs.rm(paths().stamp)
    const asked = fakeUv([ok('', 'Nothing to upgrade\n')])
    expect(await ensure(opts(asked.run).options)).toEqual({ ok: true, action: 'upgraded', message: 'yt-dlp 已是最新版' })
    expect(asked.checks.map(c => c.args)).toEqual([['--version']])
    expect(asked.checks[0]!.opts.timeoutMs).toBe(VERSION_TIMEOUT_MS)
  })

  it('repairs a yt-dlp that no longer runs (project folder moved): uv says "Nothing to upgrade", so it reinstalls', async () => {
    await putExe()
    const broken = failed('exec: /old/place/tools/uv/yt-dlp/bin/python: not found', 127)
    const uv = fakeUv([ok('', 'Nothing to upgrade\n'), ok('', INSTALL_OUTPUT)], { versions: [broken] })
    const { options, lines } = opts(uv.run)
    expect(await ensure(options)).toEqual({ ok: true, action: 'upgraded', message: '已重新安裝 yt-dlp（原本的無法執行，例如專案資料夾搬過位置）' })
    expect(uv.calls.map(c => c.args)).toEqual([UPGRADE_ARGS, REINSTALL_ARGS])
    expect(uv.calls[1]!.opts.env).toMatchObject({ UV_TOOL_DIR: paths().uvToolDir, UV_TOOL_BIN_DIR: paths().binDir })
    expect(uv.checks).toHaveLength(2)
    expect(lines).toContain('▶ yt-dlp 無法執行（exec: /old/place/tools/uv/yt-dlp/bin/python: not found），重新安裝…')
    expect(await readStamp(paths().stamp)).toBe(NOW)
  })

  it('warns, without a stamp, when yt-dlp still does not run after the reinstall', async () => {
    await putExe()
    const broken = failed('exec: python: not found', 127)
    const uv = fakeUv([ok('', 'Nothing to upgrade\n'), ok('', INSTALL_OUTPUT)], { versions: [broken, broken] })
    const { options, lines } = opts(uv.run)
    const result = await ensure(options)
    expect(result).toEqual({
      ok: false,
      action: 'failed',
      message: '無法更新 yt-dlp（只影響 YouTube）：重新安裝後 yt-dlp 還是無法執行（exec: python: not found）；請刪掉專案裡的 tools 資料夾，再雙擊 start.bat 重新安裝（需要網路）',
    })
    expect(lines.at(-1)).toBe(`⚠️ ${result.message}`)
    expect(existsSync(paths().stamp)).toBe(false)
  })

  it('is up to date, silently and without running uv, when checked within 24 hours', async () => {
    await putExe()
    await putStamp(NOW - 60_000)
    const uv = fakeUv([])
    const { options, lines } = opts(uv.run)
    expect(await ensure(options)).toMatchObject({ ok: true, action: 'up-to-date' })
    expect(uv.calls).toEqual([])
    expect(lines).toEqual([])
  })

  it('reports a failed upgrade, keeps the old stamp and warns that only YouTube is affected', async () => {
    await putExe()
    const stale = NOW - CHECK_INTERVAL_MS * 2
    await putStamp(stale)
    const uv = fakeUv([failed('error: Failed to upgrade yt-dlp\n  Caused by: Failed to fetch: `https://pypi.org/simple/yt-dlp/`')])
    const { options, lines } = opts(uv.run)
    const result = await ensure(options)
    expect(result).toEqual({ ok: false, action: 'failed', message: '無法更新 yt-dlp（只影響 YouTube）：uv 執行失敗：Failed to fetch: `https://pypi.org/simple/yt-dlp/`' })
    expect(await readStamp(paths().stamp)).toBe(stale)
    expect(lines.at(-1)).toBe(`⚠️ ${result.message}`)
  })

  it('reports a failed install without writing a stamp', async () => {
    const uv = fakeUv([failed('error: No solution found when resolving dependencies')])
    const { options } = opts(uv.run)
    expect(await ensure(options)).toMatchObject({ ok: false, action: 'failed', message: expect.stringMatching(/^無法安裝 yt-dlp（只影響 YouTube）：uv 執行失敗：No solution found/) })
    expect(existsSync(paths().stamp)).toBe(false)
  })

  it('fails when uv exits 0 but no executable appears', async () => {
    const uv = fakeUv([ok('', INSTALL_OUTPUT)], { createExe: false })
    const { options } = opts(uv.run)
    expect(await ensure(options)).toMatchObject({ ok: false, action: 'failed', message: expect.stringContaining('找不到') })
    expect(existsSync(paths().stamp)).toBe(false)
  })

  it('asks for setup.bat when uv is missing', async () => {
    const uv = fakeUv([missing])
    const { options } = opts(uv.run)
    expect(await ensure(options)).toEqual({ ok: false, action: 'failed', message: '無法安裝 yt-dlp（只影響 YouTube）：找不到 uv，請重新執行 setup.bat' })
  })

  it('gives up after the timeout without a stamp', async () => {
    await putExe()
    const uv = fakeUv([timedOut])
    const { options } = opts(uv.run, { timeoutMs: 5000 })
    const result = await ensure(options)
    expect(result).toMatchObject({ ok: false, action: 'failed' })
    expect(result.message).toMatch(/uv 超過 5 秒沒有完成/)
    expect(uv.calls[0].opts.timeoutMs).toBe(5000)
    expect(existsSync(paths().stamp)).toBe(false)
  })

  it('installs over an executable uv does not know about', async () => {
    await putExe()
    const uv = fakeUv([failed('error: Failed to upgrade yt-dlp\n  Caused by: `yt-dlp` is not installed; run `uv tool install yt-dlp` to install', 1), ok('', INSTALL_OUTPUT)])
    const { options } = opts(uv.run)
    expect(await ensure(options)).toMatchObject({ ok: true, action: 'installed' })
    expect(uv.calls.map(c => c.args)).toEqual([UPGRADE_ARGS, INSTALL_ARGS])
  })

  it('never throws, even when the runner does', async () => {
    const { options } = opts(async () => { throw new Error('boom') })
    expect(await ensure(options)).toMatchObject({ ok: false, action: 'failed', message: expect.stringContaining('boom') })
  })
})

/**
 * A fake uv that keeps uv's state on disk the way uv 0.11 does on Windows: UV_TOOL_DIR/yt-dlp holds the
 * environment (here just its python) and the receipt, which names the executable by its absolute path;
 * UV_TOOL_BIN_DIR/yt-dlp is a copy (not a symlink) that runs the environment's python by its absolute
 * path, so `--version` fails once that python is gone. `tool install` removes the executable the receipt
 * names and builds the environment; then, without --force, a file still at the target fails the install
 * with "Executable already exists" and removes that environment (uv's finalize_tool_install).
 * `tool upgrade` needs the receipt.
 */
function diskUv() {
  const calls: string[][] = []
  const run = async (command: string, args: string[], callOpts: Call['opts']): Promise<RunResult> => {
    if (command !== 'uv') {
      const python = await fs.readFile(command, 'utf8').catch(() => null)
      if (python === null) return { ...failed('', 1), notFound: true }
      return existsSync(python) ? ok('2026.10.26\n') : failed(`exec: ${python}: not found`, 127)
    }
    calls.push(args)
    const envDir = path.join(callOpts.env!.UV_TOOL_DIR!, 'yt-dlp')
    const receiptFile = path.join(envDir, 'uv-receipt.json')
    const receipt = await fs.readFile(receiptFile, 'utf8').then(text => JSON.parse(text) as { installPath: string }, () => null)
    if (args[1] === 'upgrade') {
      if (!receipt) return failed('error: Failed to upgrade yt-dlp\n  Caused by: `yt-dlp` is not installed; run `uv tool install yt-dlp` to install', 1)
      return ok('', 'Nothing to upgrade\n')
    }
    if (receipt) await fs.rm(receipt.installPath, { force: true })
    const python = path.join(envDir, 'bin', 'python')
    await fs.rm(envDir, { recursive: true, force: true })
    await fs.mkdir(path.dirname(python), { recursive: true })
    await fs.writeFile(python, '')
    const exe = path.join(callOpts.env!.UV_TOOL_BIN_DIR!, 'yt-dlp')
    if (!args.includes('--force') && existsSync(exe)) {
      await fs.rm(envDir, { recursive: true, force: true })
      return failed('error: Executable already exists: yt-dlp (use `--force` to overwrite)')
    }
    await fs.mkdir(path.dirname(exe), { recursive: true })
    await fs.writeFile(exe, python)
    await fs.writeFile(receiptFile, JSON.stringify({ installPath: exe }))
    return ok('', INSTALL_OUTPUT)
  }
  return { run, calls }
}

describe('a moved project folder on Windows (tools/bin/yt-dlp.exe is a copy the receipt no longer names)', () => {
  /** Installs into <tmp>/<from>, then moves the project folder to <tmp>/<to>. */
  async function installAndMove(from: string, to: string) {
    const before = path.join(tmp, from)
    expect(await install(opts(diskUv().run, { root: before }).options)).toMatchObject({ ok: true, message: '已安裝 yt-dlp 2026.10.26' })
    const root = path.join(tmp, to)
    await fs.rename(before, root)
    return { root, p: ytdlpPaths(root, 'linux') }
  }

  it('the fake behaves like uv: the reinstall without --force fails and removes the environment', async () => {
    const { root, p } = await installAndMove('a', 'b')
    const uv = diskUv()
    const r = await uv.run('uv', ['tool', 'install', '--reinstall', 'yt-dlp[default,deno]'], { env: uvEnv(root, {}, 'linux') })
    expect(r).toMatchObject({ ok: false, stderr: expect.stringContaining('Executable already exists') })
    expect(existsSync(path.join(p.uvToolDir, 'yt-dlp'))).toBe(false)
    expect(existsSync(p.exe)).toBe(true)
  })

  it('start.bat repairs it after the server asked for a check: the reinstall overwrites the copy', async () => {
    const { root, p } = await installAndMove('a', 'b')
    await fs.rm(p.stamp)
    const uv = diskUv()
    const { options, lines } = opts(uv.run, { root })
    expect(await ensure(options)).toEqual({ ok: true, action: 'upgraded', message: '已重新安裝 yt-dlp（原本的無法執行，例如專案資料夾搬過位置）' })
    expect(uv.calls).toEqual([UPGRADE_ARGS, REINSTALL_ARGS])
    expect(lines).toContain(`▶ yt-dlp 無法執行（exec: ${path.join(tmp, 'a', 'tools', 'uv', 'yt-dlp', 'bin', 'python')}: not found），重新安裝…`)
    expect(await uv.run(p.exe, ['--version'], {})).toMatchObject({ ok: true })
    expect(JSON.parse(await fs.readFile(path.join(p.uvToolDir, 'yt-dlp', 'uv-receipt.json'), 'utf8'))).toEqual({ installPath: p.exe })
    expect(await readStamp(p.stamp)).toBe(NOW)
  })

  it('recovers when only the executable is left (an earlier failed repair let uv remove the environment)', async () => {
    const { root, p } = await installAndMove('a', 'b')
    await fs.rm(p.uvToolDir, { recursive: true })
    await fs.rm(p.stamp)
    const uv = diskUv()
    expect(await ensure(opts(uv.run, { root }).options)).toEqual({ ok: true, action: 'installed', message: '已安裝 yt-dlp 2026.10.26' })
    expect(uv.calls).toEqual([UPGRADE_ARGS, INSTALL_ARGS])
    expect(await uv.run(p.exe, ['--version'], {})).toMatchObject({ ok: true })
  })

  it('setup.bat repairs it too', async () => {
    const { root, p } = await installAndMove('a', 'b')
    const uv = diskUv()
    expect(await install(opts(uv.run, { root }).options)).toEqual({ ok: true, action: 'installed', message: '已安裝 yt-dlp 2026.10.26' })
    expect(uv.calls).toEqual([INSTALL_ARGS])
    expect(await uv.run(p.exe, ['--version'], {})).toMatchObject({ ok: true })
  })
})

describe('install (setup.bat)', () => {
  it('runs uv tool install --upgrade even when yt-dlp is already there', async () => {
    await putExe()
    await putStamp(NOW - 60_000)
    const uv = fakeUv([ok('', 'Resolved 12 packages\nChecked 12 packages\nInstalled 1 executable: yt-dlp\n')])
    const { options, lines } = opts(uv.run, { now: () => NOW + 1000 })
    expect(await install(options)).toEqual({ ok: true, action: 'installed', message: '已安裝 yt-dlp' })
    expect(uv.calls.map(c => c.args)).toEqual([INSTALL_ARGS])
    expect(await readStamp(paths().stamp)).toBe(NOW + 1000)
    expect(lines.at(-1)).toBe('✅ 已安裝 yt-dlp')
  })

  it('checks that the installed yt-dlp runs; a broken one is reinstalled, a failed reinstall warns', async () => {
    const good = fakeUv([ok('', INSTALL_OUTPUT)])
    expect(await install(opts(good.run).options)).toMatchObject({ ok: true, action: 'installed', message: '已安裝 yt-dlp 2026.10.26' })
    expect(good.checks).toHaveLength(1)

    await fs.rm(paths().stamp)
    const repaired = fakeUv([ok('', INSTALL_OUTPUT), ok('', INSTALL_OUTPUT)], { versions: [timedOut] })
    const { options, lines } = opts(repaired.run)
    expect(await install(options)).toMatchObject({ ok: true, action: 'installed', message: '已重新安裝 yt-dlp（原本的無法執行，例如專案資料夾搬過位置）' })
    expect(repaired.calls.map(c => c.args)).toEqual([INSTALL_ARGS, REINSTALL_ARGS])
    expect(lines).toContain(`▶ yt-dlp 無法執行（${VERSION_TIMEOUT_MS / 1000} 秒內沒有回應），重新安裝…`)

    await fs.rm(paths().stamp)
    const offline = fakeUv([ok('', INSTALL_OUTPUT), failed('error: Failed to fetch')], { versions: [failed('boom', 1)] })
    expect(await install(opts(offline.run).options)).toMatchObject({
      ok: false,
      action: 'failed',
      message: expect.stringMatching(/^無法安裝 yt-dlp（只影響 YouTube）：yt-dlp 無法執行，重新安裝也失敗（uv 執行失敗：Failed to fetch）；請刪掉專案裡的 tools 資料夾/),
    })
    expect(existsSync(paths().stamp)).toBe(false)
  })

  it('does nothing with GG_YTDLP_CMD and says so', async () => {
    const uv = fakeUv([])
    const { options, lines } = opts(uv.run, { env: { GG_YTDLP_CMD: '["node","fake.mjs"]' } })
    expect(await install(options)).toMatchObject({ ok: true, action: 'skipped' })
    expect(uv.calls).toEqual([])
    expect(lines).toEqual([expect.stringContaining('GG_YTDLP_CMD')])
  })

  it('returns a failure instead of throwing', async () => {
    const uv = fakeUv([timedOut])
    const { options } = opts(uv.run)
    expect(await install(options)).toMatchObject({ ok: false, action: 'failed', message: expect.stringMatching(/^無法安裝 yt-dlp（只影響 YouTube）：uv 超過 600 秒/) })
  })
})

describe('main', () => {
  it('maps the commands to exit codes', async () => {
    const lines: string[] = []
    const log = (msg: string) => lines.push(msg)
    const base = { root: tmp, env: {}, platform: 'linux' as NodeJS.Platform, now: () => NOW, log }
    expect(await main(['install'], { ...base, run: fakeUv([ok('', INSTALL_OUTPUT)]).run })).toBe(0)
    expect(await main(['ensure'], { ...base, run: fakeUv([]).run })).toBe(0) // checked just now
    expect(lines.at(-1)).toMatch(/^✅ 24 小時內已經檢查過/)
    expect(await main(['ensure'], { ...base, env: { GG_YTDLP_CMD: 'fake' }, run: fakeUv([]).run })).toBe(0)
    await fs.rm(paths().stamp)
    expect(await main(['ensure'], { ...base, run: fakeUv([missing]).run })).toBe(1)
    expect(await main(['install'], { ...base, run: fakeUv([failed('error: x')]).run })).toBe(1)
    expect(await main([], { ...base, run: fakeUv([]).run })).toBe(2)
    expect(lines.at(-1)).toMatch(/^用法：node scripts\/ytdlp\.mjs/)
    expect(await main(['--help'], { ...base, run: fakeUv([]).run })).toBe(0)
  })

  it('can be imported without side effects, and runs as a CLI', () => {
    const r = spawnSync(process.execPath, [path.join(here, 'ytdlp.mjs'), 'ensure'], {
      cwd: tmp,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, GG_YTDLP_CMD: 'node fake-yt-dlp.mjs' },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/已設定 GG_YTDLP_CMD/)
  })
})

describe('runProcess', () => {
  it('collects output and the exit code without a shell', async () => {
    const r = await runProcess(process.execPath, ['-e', 'console.log("out & $HOME"); console.error("err"); process.exit(3)'])
    expect(r).toMatchObject({ ok: false, code: 3, notFound: false, timedOut: false })
    expect(r.stdout.trim()).toBe('out & $HOME')
    expect(r.stderr.trim()).toBe('err')
    expect(await runProcess(process.execPath, ['-e', ''])).toMatchObject({ ok: true, code: 0 })
  })

  it('reports a missing command', async () => {
    const r = await runProcess(path.join(tmp, 'no-such-uv'), ['--version'])
    expect(r).toMatchObject({ ok: false, notFound: true, timedOut: false })
  })

  it('kills a process that runs past the timeout', async () => {
    const pidFile = path.join(tmp, 'pid')
    const started = Date.now()
    const r = await runProcess(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`], { timeoutMs: 1000 })
    expect(r).toMatchObject({ ok: false, timedOut: true, error: 'timeout' })
    expect(Date.now() - started).toBeLessThan(10_000)
    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    const deadline = Date.now() + 5000
    let alive = true
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })

  it('uses taskkill /T /F for the process tree on Windows', async () => {
    const { EventEmitter } = await import('node:events')
    const spawned: { command: string, args: string[] }[] = []
    const fakeSpawn = (command: string, args: string[]) => {
      spawned.push({ command, args })
      const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, kill: () => true, stdout: null, stderr: null })
      return child
    }
    const r = await runProcess('uv', ['tool', 'upgrade', 'yt-dlp'], { timeoutMs: 20, platform: 'win32', spawn: fakeSpawn as never })
    expect(r.timedOut).toBe(true)
    expect(spawned).toEqual([
      { command: 'uv', args: ['tool', 'upgrade', 'yt-dlp'] },
      { command: 'taskkill', args: ['/pid', '4321', '/T', '/F'] },
    ])
  })
})
