import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'dist', 'bytifi-bundle.cjs')
const require = createRequire(import.meta.url)
const { version } = require('../package.json')

test('build:bundle injects version and strips createRequire(import.meta.url)', () => {
  const build = spawnSync(process.execPath, ['scripts/build-bundle.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(build.status, 0, build.stderr || build.stdout)
  assert.ok(fs.existsSync(bundlePath), 'expected dist/bytifi-bundle.cjs')

  const source = fs.readFileSync(bundlePath, 'utf8')
  assert.match(source, new RegExp(JSON.stringify(version)))
  assert.doesNotMatch(
    source,
    /createRequire\s*\(/,
    'Windows pkg bundle must not call createRequire (import.meta.url is undefined in the snapshot)',
  )
  assert.doesNotMatch(source, /import_meta\.url|import\.meta\.url/)
})

test('bundled CLI starts and prints version', () => {
  assert.ok(fs.existsSync(bundlePath), 'run the build test first or npm run build:bundle')
  const result = spawnSync(process.execPath, [bundlePath, '--version'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.stdout.trim(), version)
})
