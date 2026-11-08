// Shared helpers for the launcher, setup and doctor scripts (plain Node, no dependencies).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Project root: the folder above scripts/. */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const MIN_NODE_VERSION = '22.12.0'

/** Commands that are .cmd shims on Windows and need a shell to start. */
const WINDOWS_SHIMS = new Set(['pnpm', 'npm', 'npx', 'corepack'])
const SAFE_SHELL_ARG = /^[\w@.:=/\\+-]+$/

function normalizeForCompare(file) {
  let resolved
  try {
    resolved = fs.realpathSync(file)
  }
  catch {
    resolved = path.resolve(file)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  return normalizeForCompare(argv1) === normalizeForCompare(fileURLToPath(metaUrl))
}

/** [major, minor, patch] of the first x.y(.z) in `text`, or null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/** -1 / 0 / 1 like a sort comparator; unparsable versions sort first. */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

export function nodeVersionOk(version = process.versions.node, min = MIN_NODE_VERSION) {
  return compareVersions(version, min) >= 0
}

/** True when node:sqlite can be loaded (unflagged since Node 22.13). */
export async function hasNodeSqlite() {
  // Loading it prints an ExperimentalWarning on some versions; keep the scripts' output clean.
  const emitWarning = process.emitWarning
  process.emitWarning = function (warning, ...rest) {
    if (/sqlite/i.test(String(warning?.message ?? warning))) return
    return emitWarning.call(process, warning, ...rest)
  }
  try {
    await import('node:sqlite')
    return true
  }
  catch {
    return false
  }
  finally {
    process.emitWarning = emitWarning
  }
}

/** Chinese message describing why this Node.js cannot run the app, or null when it can. */
export async function nodeProblem(version = process.versions.node, sqlite = hasNodeSqlite) {
  if (!nodeVersionOk(version)) {
    return `Node.js 版本太舊（v${version}），需要 ${MIN_NODE_VERSION} 以上。請執行 setup.bat，或到 https://nodejs.org 安裝 LTS 版。`
  }
  if (!(await sqlite())) {
    return `這個 Node.js（v${version}）無法載入 node:sqlite，請升級到 22.13 以上的 LTS 版。`
  }
  return null
}

/**
 * How to spawn `command args` without a shell, except for Windows .cmd shims (pnpm, npm…),
 * which Node can only start through cmd.exe. Those get a fixed command string and refuse
 * arguments with shell metacharacters.
 */
export function commandSpec(command, args = [], platform = process.platform) {
  if (platform === 'win32' && WINDOWS_SHIMS.has(command)) {
    for (const arg of args) {
      if (!SAFE_SHELL_ARG.test(arg)) throw new Error(`Unsafe argument for ${command}: ${arg}`)
    }
    return { command: [command, ...args].join(' '), args: [], shell: true }
  }
  return { command, args, shell: false }
}

/**
 * Runs a command and collects its output. Never rejects.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, platform?: NodeJS.Platform }} [opts]
 * @returns {Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, notFound: boolean, timedOut: boolean, error: string | null }>}
 */
export function runCommand(command, args = [], opts = {}) {
  return new Promise((resolve) => {
    let spec
    try {
      spec = commandSpec(command, args, opts.platform)
    }
    catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', notFound: false, timedOut: false, error: err.message })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    let child
    try {
      child = spawn(spec.command, spec.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: spec.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
    catch (err) {
      finish({ ok: false, code: null, stdout, stderr, notFound: err.code === 'ENOENT', timedOut, error: err.message })
      return
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, opts.timeoutMs)
    }
    child.on('error', (err) => {
      finish({ ok: false, code: null, stdout, stderr, notFound: err.code === 'ENOENT', timedOut, error: err.message })
    })
    child.on('close', (code) => {
      // cmd.exe reports a missing command as exit code 1 + this message.
      const shellNotFound = spec.shell && code !== 0 && /is not recognized as an internal or external command|不是內部或外部命令/i.test(stderr)
      finish({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        notFound: shellNotFound || (spec.shell && code === 127),
        timedOut,
        error: timedOut ? 'timeout' : null,
      })
    })
  })
}

/** Runs a command with inherited stdio (the user sees its output); resolves with the exit code. */
export function runInherited(command, args = [], opts = {}) {
  return new Promise((resolve) => {
    let spec
    try {
      spec = commandSpec(command, args, opts.platform)
    }
    catch {
      resolve(1)
      return
    }
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: spec.shell,
      windowsHide: true,
      stdio: 'inherit',
    })
    child.on('error', () => resolve(127))
    child.on('close', code => resolve(code ?? 1))
  })
}

/** Last non-empty line of a command's output, trimmed to a readable length. */
export function lastLine(text, max = 200) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const line = lines.at(-1) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
