// Starts the real Nitro build (.output/server/index.mjs) for API tests, rebuilding first when the sources changed.
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-ignore -- plain ESM helpers without type declarations
import { buildStatus, computeBuildStamp, SERVER_ENTRY, writeBuildStamp } from '../../scripts/start.mjs'
// @ts-ignore -- plain ESM helpers without type declarations
import { runCommand } from '../../scripts/lib/common.mjs'

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const FAKE_TRANSCRIBER = path.join(ROOT_DIR, 'server', 'lib', 'jobs', 'test-helpers', 'fake-transcriber.mjs')
export const FAKE_YTDLP = path.join(ROOT_DIR, 'server', 'lib', 'youtube', 'test-helpers', 'fake-yt-dlp.mjs')

/** Test files run in parallel workers: only one of them builds, the others wait for it (a lock folder). */
const BUILD_LOCK = path.join(ROOT_DIR, 'node_modules', '.gg-test-build-lock')
const STALE_LOCK_MS = 15 * 60_000

function tryLock(): boolean {
  try {
    fs.mkdirSync(BUILD_LOCK)
    return true
  }
  catch {
    try {
      // A lock left by a killed test run.
      if (Date.now() - fs.statSync(BUILD_LOCK).mtimeMs > STALE_LOCK_MS) fs.rmSync(BUILD_LOCK, { recursive: true, force: true })
    }
    catch {
      // gone meanwhile
    }
    return false
  }
}

/** Runs `pnpm build` unless .output matches the current sources (same stamp as scripts/start.mjs). */
export async function ensureBuild(): Promise<void> {
  for (;;) {
    const stamp = await computeBuildStamp(ROOT_DIR) as string
    const status = await buildStatus(ROOT_DIR, stamp) as { needed: boolean }
    if (!status.needed) return
    if (!tryLock()) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      continue
    }
    try {
      const result = await runCommand('pnpm', ['build'], { cwd: ROOT_DIR }) as { ok: boolean, stdout: string, stderr: string, error?: string }
      if (!result.ok || !fs.existsSync(path.join(ROOT_DIR, SERVER_ENTRY))) {
        throw new Error(`pnpm build failed:\n${result.error ?? ''}\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`)
      }
      await writeBuildStamp(ROOT_DIR, stamp)
      return
    }
    finally {
      fs.rmSync(BUILD_LOCK, { recursive: true, force: true })
    }
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

export interface RunningServer {
  url: string
  child: ChildProcess
  output: () => string
  /** SIGTERM and wait for the exit; resolves with the exit code. */
  stop: () => Promise<number | null>
}

/**
 * Runs the built server on a free port. `host: null` leaves HOST / NITRO_HOST unset, to see where the
 * server listens on its own. GG_OLLAMA_URL is 'off' and GG_YTDLP_CMD the fake yt-dlp unless `env` sets
 * them, so a developer's real Ollama or yt-dlp (and YouTube) is never used.
 */
export async function startServer(env: Record<string, string>, opts: { host?: string | null } = {}): Promise<RunningServer> {
  const port = await freePort()
  let output = ''
  const host = opts.host === undefined ? '127.0.0.1' : opts.host
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GG_OLLAMA_URL: 'off',
    GG_YTDLP_CMD: JSON.stringify([process.execPath, FAKE_YTDLP]),
    ...env,
    PORT: String(port),
    NODE_ENV: 'production',
  }
  delete childEnv.NITRO_HOST
  delete childEnv.NITRO_PORT
  if (host === null) delete childEnv.HOST
  else childEnv.HOST = host
  const child = spawn(process.execPath, [path.join(ROOT_DIR, SERVER_ENTRY)], {
    cwd: ROOT_DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { output += chunk })
  child.stderr?.on('data', (chunk: string) => { output += chunk })
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  const url = `http://127.0.0.1:${port}`

  const deadline = Date.now() + 30_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`)
    try {
      const res = await fetch(`${url}/api/system`)
      if (res.ok) break
    }
    catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`server did not start:\n${output}`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  return {
    url,
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      const code = await exited
      clearTimeout(timer)
      return code
    },
  }
}

export interface ApiResponse<T = unknown> {
  status: number
  headers: Headers
  body: T
  text: string
}

/** JSON request (Accept: application/json, like the UI). */
export async function api<T = any>(base: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'accept': 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  }
  catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, body: parsed as T, text }
}

/** Raw bytes of a GET (for media and downloads). */
export async function getBytes(base: string, url: string, headers: Record<string, string> = {}, method = 'GET') {
  const res = await fetch(`${base}${url}`, { method, headers })
  const bytes = Buffer.from(await res.arrayBuffer())
  return { status: res.status, headers: res.headers, bytes }
}

/** Streams a file as the raw request body (like the UI's XHR upload). */
export function uploadFile(base: string, filePath: string, headers: Record<string, string>): Promise<{ status: number, body: any }> {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size
    const req = http.request(`${base}/api/uploads`, {
      method: 'POST',
      headers: { 'accept': 'application/json', 'content-type': 'application/octet-stream', 'content-length': String(size), ...headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        let body: unknown = text
        try {
          body = JSON.parse(text)
        }
        catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    fs.createReadStream(filePath).pipe(req)
  })
}

export async function waitUntil<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitUntil: timed out')
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
