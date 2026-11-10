import { defineEventHandler } from 'h3'
import { notFound } from '../lib/api'

/** `/api` itself (and `/api/`): the catch-all `[...].ts` only covers the paths below it. */
export default defineEventHandler(() => {
  throw notFound('找不到這個 API')
})
