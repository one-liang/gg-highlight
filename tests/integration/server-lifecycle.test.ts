// The built server on its own: where it listens without HOST, how fast it stops while a video streams,
// and that closing the console window (SIGHUP on Windows) still shuts it down gracefully.
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SourceVideo } from '../../shared/types/domain'
// @ts-ignore -- plain ESM helpers without type declarations
import { serverEnv } from '../../scripts/start.mjs'
import { type FakeOllama, startFakeOllama } from '../../server/lib/llm/test-helpers/fake-ollama.mjs'
import { fixtures } from '../fixtures'
import { api, ensureBuild, FAKE_TRANSCRIBER, type RunningServer, startServer, waitUntil } from './server'

let tmp: string
const running: RunningServer[] = []
const ollamas: FakeOllama[] = []

beforeAll(async () => {
  await ensureBuild()
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gg-lifecycle-'))
})

afterAll(async () => {
  await Promise.all(running.map(s => s.stop()))
  await Promise.all(ollamas.map(o => o.close()))
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function baseEnv(name: string): Record<string, string> {
  return {
    GG_DATA_DIR: path.join(tmp, name),
    GG_TRANSCRIBER_CMD: JSON.stringify([process.execPath, FAKE_TRANSCRIBER]),
    GG_VIDEO_ENCODER: 'libx264',
    GG_ASR_DEVICE: 'cpu',
  }
}

describe('built server', () => {
  it('listens on 127.0.0.1 when HOST is not set (not on every interface)', async () => {
    const server = await startServer(baseEnv('no-host'), { host: null })
    running.push(server)
    const port = new URL(server.url).port
    await waitUntil(async () => /Listening on /.test(server.output()), 10_000, 50)
    expect(server.output()).toContain(`Listening on http://127.0.0.1:${port}`)
    expect(server.output()).not.toMatch(/Listening on http:\/\/(?:0\.0\.0\.0|\[::\])/)
    expect(await server.stop()).toBe(0)
  })

  it('stops within a few seconds while a video is streaming, with the launcher\'s shutdown timeout', async () => {
    const watchDir = path.join(tmp, 'watch')
    await fsp.mkdir(watchDir, { recursive: true })
    const filePath = path.join(watchDir, 'sample-en.mp4')
    await fsp.copyFile(fixtures().sampleEnMp4, filePath)

    const launcherEnv = serverEnv({}) as Record<string, string>
    const server = await startServer({ ...baseEnv('streaming'), NITRO_SHUTDOWN_TIMEOUT: launcherEnv.NITRO_SHUTDOWN_TIMEOUT! })
    running.push(server)
    expect((await api(server.url, 'PUT', '/api/settings', { watchFolders: [watchDir] })).status).toBe(200)
    const added = await api<SourceVideo>(server.url, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath, language: 'en', audioTrack: 0 })
    expect(added.status).toBe(200)

    // Like a <video> element: the media response stays open while the page is shown.
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get(`${server.url}/api/videos/${added.body.id}/media`, { agent: false }, resolve).on('error', reject)
    })
    res.pause()
    res.on('error', () => {})
    expect(res.statusCode).toBe(200)

    const started = Date.now()
    const code = await server.stop()
    const elapsed = Date.now() - started
    res.destroy()
    // Nitro's default (30 s) outlasted start.mjs's 15 s force kill, so the 'close' hook never ran.
    expect(code).toBe(0)
    expect(elapsed).toBeLessThan(10_000)
  })

  it('SIGHUP (the console window being closed) shuts down gracefully with the launcher\'s env: the Ollama model is unloaded', async () => {
    const watchDir = path.join(tmp, 'watch-hup')
    await fsp.mkdir(watchDir, { recursive: true })
    const filePath = path.join(watchDir, 'sample-en.mp4')
    await fsp.copyFile(fixtures().sampleEnMp4, filePath)
    const ollama = await startFakeOllama({ scenario: 'hang' })
    ollamas.push(ollama)

    const launcherEnv = serverEnv({}) as Record<string, string>
    expect(launcherEnv.NITRO_SHUTDOWN_SIGNALS!.split(' ')).toContain('SIGHUP')
    const server = await startServer({
      ...baseEnv('hup'),
      NITRO_SHUTDOWN_TIMEOUT: launcherEnv.NITRO_SHUTDOWN_TIMEOUT!,
      NITRO_SHUTDOWN_SIGNALS: launcherEnv.NITRO_SHUTDOWN_SIGNALS!,
      GG_OLLAMA_URL: ollama.url,
    })
    running.push(server)
    expect((await api(server.url, 'PUT', '/api/settings', { watchFolders: [watchDir] })).status).toBe(200)
    expect((await api(server.url, 'POST', '/api/videos', { sourceKind: 'watch-folder', filePath, language: 'en', audioTrack: 0 })).status).toBe(200)
    // The AI step is reading (the fake Ollama never answers), as during a long recording.
    await waitUntil(async () => ollama.requests.some(r => r.path === '/api/chat' && r.body?.messages?.length > 0), 60_000)

    const exited = new Promise<{ code: number | null, signal: string | null }>(resolve => server.child.once('exit', (code, signal) => resolve({ code, signal })))
    server.child.kill('SIGHUP')
    const { code, signal } = await exited
    // Without SIGHUP among Nitro's shutdown signals, Node dies at once (signal SIGHUP) and the model stays loaded.
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(ollama.requests.at(-1)?.body).toMatchObject({ messages: [], keep_alive: 0 })
  })
})
