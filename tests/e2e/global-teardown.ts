// Removes the throwaway data folder the config created for this run.
import fs from 'node:fs'

export default function globalTeardown() {
  const dir = process.env.GG_E2E_DATA_DIR
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
  catch (err) {
    // the server may still hold the database open (Windows); it is only a temp folder
    console.warn(`[e2e] could not remove ${dir}: ${(err as Error).message}`)
  }
}
