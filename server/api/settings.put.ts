import { defineEventHandler } from 'h3'
import type { Settings } from '../../shared/types/domain'
import { normalizeWatchFolders, parseWith, readJsonBody, settingsSchema } from '../lib/api'
import { useServices } from '../lib/services'

/** Saves the settings; every Watch Folder must be an existing absolute folder (duplicates are dropped). */
export default defineEventHandler(async (event): Promise<Settings> => {
  const { repos } = useServices()
  const body = parseWith(settingsSchema, await readJsonBody(event))
  const watchFolders = await normalizeWatchFolders(body.watchFolders)
  return repos.settings.save({ ...repos.settings.get(), watchFolders })
})
