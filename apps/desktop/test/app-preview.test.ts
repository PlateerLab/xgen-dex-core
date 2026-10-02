/**
 * 앱 카드의 미리보기를 찍는 규칙(main/app-preview) — 2026-10-02.
 *
 * 서버는 앱을 그리지 못해 데스크톱이 앱을 숨은 창에 띄워 찍어 올린다. 여기서 지키는 것:
 *   - 찍는 것은 사이트와 **지금 도는** 앱뿐 — 미리보기를 위해 멈춘 앱을 깨우지 않는다.
 *   - 서버가 준 여는 주소(앱 API 아래 …/app/)만 띄운다. 다른 곳을 사용자 자격으로 열지 않는다.
 *   - 한 번에 하나씩, 실패하면 한동안 쉰다(사람이 직접 누른 것은 바로).
 *   - 그림 받기는 서버가 준 미리보기 주소만, 그림 종류만.
 */
import assert from 'assert'
import { test } from 'node:test'
import { isAppSitePath } from '@dex/protocol/agent-data'
import { AppPreviewService, PREVIEW_RETRY_MS } from '../src/main/app-preview'
import { needsPreview } from '../src/renderer/src/apps/app-gallery-model'

function rig(opts: { running?: boolean; shot?: Uint8Array | null; failUpload?: boolean } = {}) {
  const calls = { shoot: [] as string[], upload: [] as string[], state: 0 }
  let now = 1_000_000
  const client = {
    agentData: {
      appServiceState: async () => {
        calls.state += 1
        return { kind: 'service', running: opts.running ?? false }
      },
      appPreviewUpload: async (wf: string, slug: string) => {
        if (opts.failUpload) throw new Error('403')
        calls.upload.push(`${wf}/${slug}`)
        return { ok: true, slug, preview_url: `/api/agentflow/agent-apps/${wf}/${slug}/preview?v=1`, preview_at: 1 }
      },
      appPreviewImage: async (url: string) => ({
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        contentType: url.includes('svg') ? 'image/svg+xml' : 'image/jpeg',
      }),
    },
  }
  const svc = new AppPreviewService({
    client: () => client as never,
    serverBase: () => 'https://xgen.example.com',
    shoot: async (url) => {
      calls.shoot.push(url)
      return opts.shot === undefined ? new Uint8Array([0xff, 0xd8, 0xff, 1]) : opts.shot
    },
    now: () => now,
  })
  return { svc, calls, tick: (ms: number) => (now += ms) }
}

const site = { workflow_id: 'wf', slug: 'map', kind: 'project', app_url: '/api/agentflow/agent-apps/wf/map/app/' }

test('사이트는 서버 주소에 붙여 찍고 올린다', async () => {
  const { svc, calls } = rig()
  const res = await svc.capture(site)
  assert.equal(res.ok, true)
  assert.deepEqual(calls.shoot, ['https://xgen.example.com/api/agentflow/agent-apps/wf/map/app/'])
  assert.deepEqual(calls.upload, ['wf/map'])
})

test('멈춘 앱(service)은 찍지 않는다 — 직접 눌러도', async () => {
  const svc = { ...site, kind: 'service' }
  for (const force of [false, true]) {
    const { svc: s, calls } = rig({ running: false })
    const res = await s.capture({ ...svc, force })
    assert.deepEqual(res, { ok: false, reason: 'stopped' })
    assert.equal(calls.shoot.length, 0)
  }
  const { svc: s, calls } = rig({ running: true })
  assert.equal((await s.capture(svc)).ok, true)
  assert.equal(calls.shoot.length, 1)
})

test('화면(component)·서버가 주지 않은 주소는 찍지 않는다', async () => {
  const { svc, calls } = rig()
  assert.deepEqual(await svc.capture({ ...site, kind: 'component' }), { ok: false, reason: 'kind' })
  for (const bad of ['https://evil.example/x/app/', '//evil.example/app/', '/api/agentflow/auth/me', '/api/agentflow/agent-apps/wf/../../x/app/']) {
    assert.deepEqual(await svc.capture({ ...site, slug: bad, app_url: bad, force: true }), { ok: false, reason: 'url' }, bad)
  }
  assert.equal(calls.shoot.length, 0)
})

test('못 찍었으면 한동안 쉬고, 직접 누르면 바로 다시 찍는다', async () => {
  const { svc, calls, tick } = rig({ shot: null })
  assert.deepEqual(await svc.capture(site), { ok: false, reason: 'empty' })
  assert.deepEqual(await svc.capture(site), { ok: false, reason: 'cooldown' })
  assert.equal(calls.shoot.length, 1)
  await svc.capture({ ...site, force: true })
  assert.equal(calls.shoot.length, 2)
  tick(PREVIEW_RETRY_MS + 1)
  await svc.capture(site)
  assert.equal(calls.shoot.length, 3)
})

test('같은 앱을 겹쳐 부탁하면 한 번만, 앱끼리는 차례로 찍는다', async () => {
  const { svc, calls } = rig()
  const [a, b, c] = await Promise.all([
    svc.capture(site),
    svc.capture(site),
    svc.capture({ ...site, slug: 'chart', app_url: '/api/agentflow/agent-apps/wf/chart/app/' }),
  ])
  assert.equal(a, b)
  assert.equal(c.ok, true)
  assert.deepEqual(calls.shoot.map((u) => u.split('/').slice(-3, -2)[0]), ['map', 'chart'])
})

test('올리기가 실패하면 이유를 돌려준다(던지지 않는다)', async () => {
  const { svc } = rig({ failUpload: true })
  const res = await svc.capture(site)
  assert.equal(res.ok, false)
  assert.equal((res as { reason: string }).reason, 'error')
})

test('그림은 미리보기 주소만, 그림 종류만 data URL 로', async () => {
  const { svc } = rig()
  assert.match(await svc.image('/api/agentflow/agent-apps/wf/map/preview?v=1'), /^data:image\/jpeg;base64,/)
  assert.equal(await svc.image('/api/agentflow/auth/me'), '')
  assert.equal(await svc.image('/api/agentflow/agent-apps/wf/svg/preview'), '', 'svg 는 그림으로 받지 않는다')
})

test('여는 주소 판정', () => {
  assert.equal(isAppSitePath('/api/agentflow/agent-apps/wf/map/app/'), true)
  assert.equal(isAppSitePath('/api/agentflow/agent-artifacts/wf/map/app'), true)
  assert.equal(isAppSitePath('/api/agentflow/agent-apps/wf/map/preview'), false)
})

test('다시 찍을지: 그림이 없거나 앱이 그림보다 나중에 바뀐 열리는 사이트·앱', () => {
  const base = { kind: 'project' as const, ready: true, updated_at: 100, preview_url: '/p' as string | undefined, preview_at: 200 }
  assert.equal(needsPreview(base), false)
  assert.equal(needsPreview({ ...base, preview_url: '' }), true)
  assert.equal(needsPreview({ ...base, preview_at: 50 }), true)
  assert.equal(needsPreview({ ...base, ready: false, preview_url: '' }), false)
  assert.equal(needsPreview({ ...base, kind: 'component' as const, preview_url: '' }), false)
  assert.equal(needsPreview({ ...base, preview_url: undefined }), false, '옛 서버는 미리보기를 모른다')
})
