import { defineEventHandler } from 'h3'
import type { SystemInfo } from '../../shared/types/domain'
import { detectVideoEncoder, fontsReady } from '../lib/media'
import { useServices } from '../lib/services'
import pkg from '../../package.json'

export default defineEventHandler(async (): Promise<SystemInfo> => {
  const { config, tools } = useServices()
  const [videoEncoder, fonts] = await Promise.all([
    detectVideoEncoder(tools, config.videoEncoderOverride),
    fontsReady(config.fontsDir),
  ])
  return {
    version: (pkg as { version?: string }).version ?? '0.0.0',
    videoEncoder,
    dataDir: config.dataDir,
    fontsReady: fonts,
  }
})
