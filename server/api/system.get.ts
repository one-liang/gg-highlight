import { defineEventHandler } from 'h3'
import type { SystemInfo } from '../../shared/types/domain'
import { ollamaInfo } from '../lib/api'
import { detectVideoEncoder, fontsReady } from '../lib/media'
import { useServices } from '../lib/services'
import pkg from '../../package.json'

export default defineEventHandler(async (): Promise<SystemInfo> => {
  const { config, tools } = useServices()
  // Ollama gets at most 1.5 s and never fails the route (it is also the readiness probe of the tests).
  const [videoEncoder, fonts, ollama] = await Promise.all([
    detectVideoEncoder(tools, config.videoEncoderOverride),
    fontsReady(config.fontsDir),
    ollamaInfo(config.ollama),
  ])
  return {
    version: (pkg as { version?: string }).version ?? '0.0.0',
    videoEncoder,
    videoEncoderForced: config.videoEncoderOverride !== null,
    dataDir: config.dataDir,
    fontsReady: fonts,
    ollama,
  }
})
