#!/usr/bin/env node
/** Rebuild generated output from an empty declaration directory. */

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

rmSync('lib/types', { recursive: true, force: true })
rmSync('lib/tsconfig.tsbuildinfo', { force: true })

execFileSync('tsc', ['-b', '--force'], { stdio: 'inherit' })
execFileSync('tsdown', [], { stdio: 'inherit' })
rmSync('lib/tsconfig.tsbuildinfo', { force: true })
