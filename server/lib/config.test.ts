import { describe, expect, it } from 'vitest'
// @ts-ignore -- plain ESM script without type declarations
import { ollamaConfig as doctorOllamaConfig } from '../../scripts/doctor.mjs'
import { applyListenDefaults, DEFAULT_HOST, DEFAULT_PORT, loadConfig, parseOllamaConfig } from './config'
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from './llm/types'

describe('applyListenDefaults', () => {
  it('listens on 127.0.0.1:3939 when nothing is set (never Nitro\'s 0.0.0.0:3000)', () => {
    const env: NodeJS.ProcessEnv = {}
    applyListenDefaults(env)
    expect(env).toEqual({ HOST: '127.0.0.1', PORT: '3939' })
    expect([DEFAULT_HOST, DEFAULT_PORT]).toEqual(['127.0.0.1', 3939])
  })

  it('keeps explicit HOST / PORT and NITRO_HOST / NITRO_PORT', () => {
    const plain: NodeJS.ProcessEnv = { HOST: '0.0.0.0', PORT: '4000' }
    applyListenDefaults(plain)
    expect(plain).toEqual({ HOST: '0.0.0.0', PORT: '4000' })

    const nitro: NodeJS.ProcessEnv = { NITRO_HOST: '::1', NITRO_PORT: '5000' }
    applyListenDefaults(nitro)
    expect(nitro).toEqual({ NITRO_HOST: '::1', NITRO_PORT: '5000' })

    const portOnly: NodeJS.ProcessEnv = { PORT: '4001' }
    applyListenDefaults(portOnly)
    expect(portOnly).toEqual({ HOST: '127.0.0.1', PORT: '4001' })
  })
})

describe('parseOllamaConfig', () => {
  const cases: Array<[NodeJS.ProcessEnv, { url: string | null, model: string }]> = [
    [{}, { url: DEFAULT_OLLAMA_URL, model: DEFAULT_OLLAMA_MODEL }],
    [{ GG_OLLAMA_URL: '', GG_OLLAMA_MODEL: '' }, { url: DEFAULT_OLLAMA_URL, model: DEFAULT_OLLAMA_MODEL }],
    [{ GG_OLLAMA_URL: '   ', GG_OLLAMA_MODEL: '  ' }, { url: DEFAULT_OLLAMA_URL, model: DEFAULT_OLLAMA_MODEL }],
    [{ GG_OLLAMA_URL: 'off' }, { url: null, model: DEFAULT_OLLAMA_MODEL }],
    [{ GG_OLLAMA_URL: ' OFF ', GG_OLLAMA_MODEL: 'qwen3.5:4b' }, { url: null, model: 'qwen3.5:4b' }],
    [{ GG_OLLAMA_URL: 'http://127.0.0.1:41234/' }, { url: 'http://127.0.0.1:41234', model: DEFAULT_OLLAMA_MODEL }],
    [{ GG_OLLAMA_URL: ' http://gpu-box:11434/// ', GG_OLLAMA_MODEL: ' qwen3:8b ' }, { url: 'http://gpu-box:11434', model: 'qwen3:8b' }],
  ]

  it('defaults to the local Ollama, turns off with "off" and strips trailing slashes', () => {
    for (const [env, expected] of cases) expect(parseOllamaConfig(env), JSON.stringify(env)).toEqual(expected)
    expect(DEFAULT_OLLAMA_URL).toBe('http://127.0.0.1:11434')
    expect(DEFAULT_OLLAMA_MODEL).toBe('qwen3.5:9b')
  })

  it('reads the environment the same way as scripts/doctor.mjs', () => {
    for (const [env] of cases) expect(parseOllamaConfig(env), JSON.stringify(env)).toEqual(doctorOllamaConfig(env))
  })

  it('is part of loadConfig', () => {
    expect(loadConfig({ GG_OLLAMA_URL: 'off' }, '/tmp').ollama).toEqual({ url: null, model: DEFAULT_OLLAMA_MODEL })
    expect(loadConfig({}, '/tmp').ollama.url).toBe(DEFAULT_OLLAMA_URL)
  })
})
