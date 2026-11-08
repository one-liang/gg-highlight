import { defineEventHandler } from 'h3'
import type { Settings } from '../../shared/types/domain'
import { useServices } from '../lib/services'

export default defineEventHandler((): Settings => useServices().repos.settings.get())
