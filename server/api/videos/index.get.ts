import { defineEventHandler } from 'h3'
import type { SourceVideo } from '../../../shared/types/domain'
import { toSourceVideo } from '../../lib/library'
import { useServices } from '../../lib/services'

export default defineEventHandler(async (): Promise<SourceVideo[]> => {
  const { repos } = useServices()
  return Promise.all(repos.videos.list().map(toSourceVideo))
})
