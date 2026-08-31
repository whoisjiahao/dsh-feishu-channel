// Runs only on `pnpm publish` (prepublishOnly): ensure the built entry
// points exist. Self-contained: no monorepo context, no type checking —
// just the bundle step. Deliberately NOT a `prepare` script: `lib/` is
// committed, so git installs never need a build, and a `prepare` script
// makes every git install trip pnpm's allowBuilds gate and install the
// full dev dependency tree for nothing. Build freshness is enforced by
// `pnpm gates` (pack smoke + version consistency) instead.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('lib/index.js')) {
  execSync('npm run build', { stdio: 'inherit' })
}
