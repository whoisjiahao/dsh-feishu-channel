// pnpm runs this after a git install: ensure the built entry points exist.
// Self-contained: no monorepo context, no type checking — just the bundle step.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('lib/index.js')) {
  execSync('npm run build', { stdio: 'inherit' })
}
