import { describe, expect, it } from 'vitest'
import { applyListenDefaults, DEFAULT_HOST, DEFAULT_PORT } from './config'

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
