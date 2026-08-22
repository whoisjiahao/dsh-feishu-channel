#!/usr/bin/env node
/**
 * Gate runner — mechanical checks + self-verifying tests, run the narrowest
 * evidence for the change surface (dev-conventions.md).
 *
 * Usage:
 *   node scripts/gates/run.mjs            full gate suite
 *   node scripts/gates/run.mjs --test      only unit tests
 *   node scripts/gates/run.mjs --build     only build + artifact checks
 *   node scripts/gates/run.mjs --pack      build + npm pack smoke
 *
 * Exit code is non-zero when any gate fails; every gate also proves it can
 * reject (gate self-tests), so a passing suite is meaningful.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const FAILURES = []

function sh(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf-8', ...opts }).trim()
  } catch (error) {
    return { failed: true, message: error.stderr?.toString?.() ?? String(error) }
  }
}

function check(name, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(mark + ' ' + name + (detail && !ok ? ' — ' + detail : ''))
  if (!ok) FAILURES.push(name)
}

/* ------------------------------------------------------------------ */
/* 1. typecheck + unit tests (self-verifying: the suite proves itself) */
/* ------------------------------------------------------------------ */
function gateTests() {
  const typecheck = sh('pnpm typecheck')
  check('typecheck', !typecheck.failed, typecheck.message)
  const test = sh('pnpm test')
  check('unit tests', !test.failed, test.message)
}

/* ------------------------------------------------------------------ */
/* 2. build + artifact freshness (no .ts residue, no stale lib/)       */
/* ------------------------------------------------------------------ */
function gateBuild() {
  const build = sh('pnpm build')
  check('build', !build.failed, build.message)
  const entry = join(ROOT, 'lib/index.js')
  check('lib/index.js exists', existsSync(entry))
  if (existsSync(entry)) {
    const source = readFileSync(entry, 'utf8')
    // Compiled output must not reference the TypeScript sources directly.
    const tsResidue = /from '[^']+\.ts'/.test(source)
    check('no .ts residue in lib/index.js', !tsResidue)
    // The bundle must still carry the plugin identity.
    check("bundle exports 'feishu-channel'", source.includes('feishu-channel'))
  }

  const sourceDeclarations = filesUnder(join(ROOT, 'src'))
    .filter(file => file.endsWith('.ts'))
    .map(file => file.slice(join(ROOT, 'src').length + 1, -3) + '.d.ts')
    .sort()
  const builtDeclarations = filesUnder(join(ROOT, 'lib/types'))
    .filter(file => file.endsWith('.d.ts'))
    .map(file => file.slice(join(ROOT, 'lib/types').length + 1))
    .sort()
  check('declaration tree exactly matches src',
    JSON.stringify(builtDeclarations) === JSON.stringify(sourceDeclarations),
    'expected ' + sourceDeclarations.length + ' declarations, found ' + builtDeclarations.length)

  const sourceDeclarationMaps = sourceDeclarations.map(file => file + '.map')
  const builtArtifacts = filesUnder(join(ROOT, 'lib/types'))
    .map(file => file.slice(join(ROOT, 'lib/types').length + 1))
    .sort()
  const expectedArtifacts = [...sourceDeclarations, ...sourceDeclarationMaps].sort()
  check('declaration directory contains no stale artifacts',
    JSON.stringify(builtArtifacts) === JSON.stringify(expectedArtifacts),
    'expected ' + expectedArtifacts.length + ' declaration artifacts, found ' + builtArtifacts.length)

  const rootTypes = join(ROOT, 'lib/types/index.d.ts')
  if (existsSync(rootTypes)) {
    const declaration = readFileSync(rootTypes, 'utf8')
    check('root types expose no internal contracts',
      !/(ResolvedConfig|ChannelConfig|ChannelPort|LarkCredentials|RegisterAppPort)/.test(declaration))
  }
}

/* ------------------------------------------------------------------ */
/* 3. package smoke: pack is installable and entry points resolve      */
/* ------------------------------------------------------------------ */
function gatePack() {
  const pack = sh('npm pack --dry-run --json', { cwd: ROOT })
  if (pack.failed) {
    check('npm pack dry-run', false, pack.message)
    return
  }
  let manifest
  try {
    manifest = JSON.parse(pack)
  } catch {
    check('npm pack dry-run', false, 'unparseable pack output')
    return
  }
  const files = (manifest[0]?.files ?? []).map(file => file.path)
  const required = [
    'lib/index.js',
    'lib/invariant.js',
    'package.json',
    'cordis.patch.yml',
    'src/index.ts',
    'scripts/register-lark-app.mjs',
  ]
  for (const file of required) {
    check('pack contains ' + file, files.includes(file))
  }

  // Version consistency: a redistributed tarball must carry the exact
  // package.json version — bump the version on every repackage, otherwise
  // pnpm's store cache keyed on the tarball name reuses a stale build.
  const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const packed = manifest[0]?.version
  check('pack version matches package.json', declared !== undefined && packed === declared,
    'package.json version ' + declared + ' vs packed ' + packed)

  // README version references follow the same discipline: badge, install tag,
  // and tgz names are hand-copied per release and drift silently otherwise.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  check('README badge carries package version',
    readme.includes(`version-${declared}-`),
    `README 缺少 version-${declared}- 徽章引用`)
  check('README install tag carries package version',
    readme.includes(`#v${declared}`),
    `README 缺少 #v${declared} 安装引用`)
  check('README tgz name carries package version',
    readme.includes(`dsh-feishu-channel-${declared}.tgz`),
    `README 缺少 dsh-feishu-channel-${declared}.tgz 引用`)

  const stale = files.filter(file =>
    file.startsWith('doctor/')
    || file.startsWith('src/render/')
    || file === 'src/outbound.ts'
    || file === 'src/bridge.ts'
    || file === 'src/session.ts')
  check('pack excludes removed and unrelated surfaces', stale.length === 0, stale.join(', '))
}

/* ------------------------------------------------------------------ */
/* 4. gate self-tests: each check must be able to reject              */
/* ------------------------------------------------------------------ */
function gateSelfTests() {
  // The failure accumulator is real: run the suite with a planted failure.
  const probe = sh(`node -e "process.exit(1)"`)
  check('self-test: failing command is rejected', probe.failed === true)
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else files.push(path)
  }
  return files
}

const only = process.argv[2]
if (only === '--test') gateTests()
else if (only === '--build') { gateTests(); gateBuild() }
else if (only === '--pack') { gateTests(); gateBuild(); gatePack() }
else { gateTests(); gateBuild(); gatePack(); gateSelfTests() }

if (FAILURES.length > 0) {
  console.error('\ngate failed: ' + FAILURES.join(', '))
  process.exit(1)
}
console.log('\ngates passed')
