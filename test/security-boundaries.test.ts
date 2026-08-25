import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizeOuterRequest, isSameOriginMutation } from '../src/server/visual.ts'
import { isPrivateIpAddress, isSafeResolvedMediaProxyUrl } from '../vendor/regret-radio/src/music/proxy.ts'
import { writeBeatmapCache } from '../vendor/regret-radio/src/music/beatmap-cache.ts'
import { validDjDuration } from '../vendor/regret-radio/src/routes/dj-beatmap.ts'
import { migrateCookieFiles } from '../vendor/regret-radio/src/music/cookie-store.ts'
import { config } from '../vendor/regret-radio/src/config.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function request(remoteAddress: string, method = 'GET', headers: Record<string, string> = {}): any {
  return { socket: { remoteAddress }, method, headers: { host: '127.0.0.1:3080', ...headers } }
}

test('outer boundary rejects remote callers before the loopback proxy', () => {
  assert.equal(authorizeOuterRequest(request('203.0.113.9'), { allowRemote: false, accessToken: '' }), false)
  assert.equal(authorizeOuterRequest(request('127.0.0.1'), { allowRemote: false, accessToken: '' }), true)
  assert.equal(authorizeOuterRequest(request('::ffff:127.0.0.1'), { allowRemote: false, accessToken: '' }), true)
  assert.equal(authorizeOuterRequest(request('127.0.0.1', 'GET', { host: 'public.example', 'x-forwarded-for': '203.0.113.9' }), { allowRemote: false, accessToken: '' }), false)
})

test('remote mode requires the configured bearer and mutations require same-origin context', () => {
  const token = 'a'.repeat(32)
  assert.equal(authorizeOuterRequest(request('203.0.113.9', 'GET', { authorization: `Bearer ${token}` }), { allowRemote: true, accessToken: token }), true)
  assert.equal(authorizeOuterRequest(request('203.0.113.9'), { allowRemote: true, accessToken: token }), false)
  assert.equal(authorizeOuterRequest(request('127.0.0.1', 'GET', { host: 'public.example', 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${token}` }), { allowRemote: true, accessToken: token }), true)
  assert.equal(isSameOriginMutation(request('127.0.0.1', 'POST', { host: '127.0.0.1:3080', origin: 'https://evil.example' })), false)
  assert.equal(isSameOriginMutation(request('127.0.0.1', 'POST', { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
})

test('media SSRF guard rejects every private DNS answer and accepts public allowlisted DNS', async () => {
  assert.equal(isPrivateIpAddress('127.0.0.1'), true)
  assert.equal(isPrivateIpAddress('fd00::1'), true)
  const privateResolver: any = async () => [{ address: '127.0.0.1', family: 4 }]
  const publicResolver: any = async () => [{ address: '203.0.113.10', family: 4 }]
  assert.equal(await isSafeResolvedMediaProxyUrl('https://music.163.com/a.mp3', ['music.163.com'], privateResolver), false)
  assert.equal(await isSafeResolvedMediaProxyUrl('https://music.163.com/a.mp3', ['music.163.com'], publicResolver), true)
})

test('beatmap cache rejects oversized attacker-controlled entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-beatmap-test-'))
  try {
    const result = writeBeatmapCache({ key: 'oversized', map: { data: 'x'.repeat(2 * 1024 * 1024) } }, dir)
    assert.deepEqual(result, { ok: false, error: 'BEATMAP_CACHE_ENTRY_TOO_LARGE' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('DJ analysis rejects non-finite and excessive duration hints', () => {
  assert.equal(validDjDuration('Infinity'), null)
  assert.equal(validDjDuration(8 * 60 * 60 + 1), null)
  assert.equal(validDjDuration(3600), 3600)
})

test('successful encrypted cookie migration removes the plaintext source', () => {
  const previous = config.security.runtimeConfigMasterKey
  config.security.runtimeConfigMasterKey = '11'.repeat(32)
  const rows = new Map<string, string>()
  const db: any = { prepare(sql: string) {
    if (sql.startsWith('SELECT')) return { get: (provider: string) => rows.has(provider) ? { cookie: rows.get(provider) } : undefined }
    if (sql.startsWith('DELETE')) return { run: (provider: string) => rows.delete(provider) }
    return { run: (provider: string, cookie: string) => rows.set(provider, cookie) }
  } }
  const existing = new Set(['netease.cookie'])
  const removed: string[] = []
  const fsLike: any = {
    existsSync: (path: string) => existing.has(path),
    readFileSync: () => 'MUSIC_U=plaintext',
    unlinkSync: (path: string) => { existing.delete(path); removed.push(path) },
  }
  try {
    migrateCookieFiles(db, fsLike, { netease: 'netease.cookie', qq: 'qq.cookie' })
    assert.match(rows.get('netease') ?? '', /^enc:v1:/)
    assert.deepEqual(removed, ['netease.cookie'])
  } finally { config.security.runtimeConfigMasterKey = previous }
})
