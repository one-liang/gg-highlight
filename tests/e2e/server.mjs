#!/usr/bin/env node
// Playwright webServer: `pnpm build` when the sources changed since the last build (same stamp as
// scripts/start.mjs), then run the Nitro server in the foreground with the environment Playwright passes.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStatus, computeBuildStamp, SERVER_ENTRY, writeBuildStamp } from '../../scripts/start.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const stamp = await computeBuildStamp(root)
const status = await buildStatus(root, stamp)
if (status.needed) {
  console.log(`[e2e] pnpm build (${status.reason})`)
  const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0 || !fs.existsSync(path.join(root, SERVER_ENTRY))) {
    console.error('[e2e] pnpm build failed')
    process.exit(1)
  }
  await writeBuildStamp(root, stamp)
}

const child = spawn(process.execPath, [path.join(root, SERVER_ENTRY)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', code => process.exit(code ?? 0))
