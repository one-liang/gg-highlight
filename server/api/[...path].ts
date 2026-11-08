import { defineEventHandler } from 'h3'
import { notFound } from '../lib/api'

/** Unknown /api/* routes get a JSON 404 instead of the SPA page. */
export default defineEventHandler(() => {
  throw notFound('找不到這個 API')
})
