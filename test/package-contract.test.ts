import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import YAML from 'yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patch = YAML.parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
const workspace = YAML.parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))

test('declares the current DSH host APIs as compatible peers', () => {
  const range = '0.1.1-rc.2 || 0.1.2-alpha.1'
  for (const name of [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-tools',
  ]) {
    assert.equal(pkg.peerDependencies[name], range)
    assert.equal(pkg.devDependencies[name], range)
  }
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '4.0.1')
  assert.equal(pkg.devDependencies['@deepseek-ai/cordis'], '4.0.1')
})

test('client injection names only packages present in current DSH', () => {
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
  ])
  assert.ok(!JSON.stringify(pkg).includes('@deepseek-ai/dsh-client-runtime'))
})

test('bundle patch mounts visual host, tools, and client entries', () => {
  const entries = patch[0].insert.map((entry: { id: string; name: string }) => [entry.id, entry.name])
  assert.deepEqual(entries, [
    ['music-server-regret-visual', '@oldsan888/dsh-music-mode/server-visual'],
    ['music-tool-music', '@oldsan888/dsh-music-mode/server-tool'],
    ['music-ui-music-mode', '@oldsan888/dsh-music-mode'],
  ])
})

test('git preparation explicitly allows native and bundler build scripts', () => {
  assert.equal(workspace.allowBuilds['better-sqlite3'], true)
  assert.equal(workspace.allowBuilds.esbuild, true)
})
