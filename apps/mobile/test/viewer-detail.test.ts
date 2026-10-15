/**
 * 폰 안에서 앱·파일을 그리는 규칙 — 2026-10-02.
 *
 * [열기] 는 이제 기기의 브라우저가 아니라 폰 안의 보기 화면으로 간다. 그 화면은 WebView 라 요청마다 로그인 머리를
 * 붙일 수 없어 같은 출처의 쿠키로 싣는다 — 내 앱에만, 남의 앱(스토어)에는 싣지 않는다.
 * 에이전트 상세의 [스토리지] 는 폴더 한 단계씩 넘기고, 파일은 데스크톱과 같은 규칙으로 그린다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { mediaBody, pagesBody, pdfBody, serverOrigin, sessionBootstrapHtml, sessionDocumentHtml } from '../src/lib/web-session'
import { folderEntries, folderTrail, parentOf } from '../src/files/workspace-tree'
import { myAppTarget, storeAppTarget } from '../src/apps/app-targets'

const JWT = 'eyJhbGciOi.eyJzdWIiOiI3In0.sig-_x'

test('시작 문서는 두 쿠키를 심고 목적지로 넘어간다 — 게이트웨이와 웹 화면이 각각 보는 이름', () => {
  const html = sessionBootstrapHtml('https://x.example/api/agentflow/agent-apps/wf/s/app/', JWT)
  assert.match(html, /document\.cookie='xgen_access_token='/)
  assert.match(html, /document\.cookie='access_token='/)
  assert.ok(html.includes(JSON.stringify(JWT)), '토큰을 그대로 싣는다')
  assert.match(html, /Secure/, 'https 서버에는 Secure 쿠키')
  assert.ok(html.includes('location.replace("https://x.example/api/agentflow/agent-apps/wf/s/app/")'))
  assert.doesNotMatch(sessionBootstrapHtml('http://10.0.0.5:8000/app/wf/s', JWT), /Secure/, 'http 서버(사내망)에서는 Secure 를 붙이면 쿠키가 버려진다')
})

test('문서는 쿠키를 먼저 심고 그린다 — 그 안의 그림·PDF·소리가 같은 출처로 로그인해 받는다', () => {
  const html = sessionDocumentHtml('<img src="/api/x">', JWT, { secure: true })
  assert.ok(html.indexOf('document.cookie') < html.indexOf('<img'), '쿠키가 그림보다 먼저')
})

test('문서 페이지 — 서버 렌더 그림을 차례로, 이름은 이스케이프한다', () => {
  const body = pagesBody(['/api/a/1.svg', '/api/a/2.svg'], '<보고서>')
  assert.equal((body.match(/<img /g) ?? []).length, 2)
  assert.ok(body.includes('&lt;보고서&gt; 1페이지'))
  assert.match(pagesBody([], 'x'), /페이지가 없습니다/)
})

test('PDF 는 pdf.js 로 그린다 — 원본은 같은 출처에서 쿠키로', () => {
  const body = pdfBody('/api/agentflow/geny-workspace/wf/storage-raw/workspace/a%20b.pdf')
  assert.ok(body.includes('"/api/agentflow/geny-workspace/wf/storage-raw/workspace/a%20b.pdf"'))
  assert.match(body, /cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\//)
  assert.match(body, /withCredentials:true/)
  assert.match(body, /pdf-failed/, '그리지 못하면 화면에 알린다(내보내기로 넘길 수 있게)')
})

test('소리·영상은 기기의 재생기로', () => {
  assert.match(mediaBody('/api/x.mp4', 'video'), /<video controls playsinline/)
  assert.match(mediaBody('/api/x.mp3', 'audio'), /<audio controls/)
})

test('서버 출처 — 주소가 틀리면 빈 값(WebView 를 열지 않는다)', () => {
  assert.equal(serverOrigin('https://xgen.example.com/some/path'), 'https://xgen.example.com')
  assert.equal(serverOrigin('not a url'), '')
})

test('스토리지 — 폴더 한 단계씩, 폴더 먼저, 폴더 줄이 없어도 경로로 세운다', () => {
  const files = [
    { name: 'uploads', path: 'uploads', is_dir: true },
    { name: 'photo.png', path: 'uploads/users_130/photo.png', is_dir: false, size: 10 },
    { name: '리포트.docx', path: '리포트.docx', is_dir: false, size: 45666 },
    { name: 'a.md', path: 'a.md', is_dir: false, size: 3 },
  ]
  // 한국어 순서 — 한글 이름이 먼저(폰의 파일 앱과 같다).
  assert.deepEqual(folderEntries(files, '').map((e) => [e.name, e.isDir]), [['uploads', true], ['리포트.docx', false], ['a.md', false]])
  assert.deepEqual(folderEntries(files, 'uploads').map((e) => [e.path, e.isDir]), [['uploads/users_130', true]])
  assert.deepEqual(folderEntries(files, 'uploads/users_130').map((e) => e.name), ['photo.png'])
  assert.deepEqual(folderTrail('uploads/users_130'), [{ name: 'uploads', path: 'uploads' }, { name: 'users_130', path: 'uploads/users_130' }])
  assert.equal(parentOf('uploads/users_130'), 'uploads')
  assert.equal(parentOf('uploads'), '')
})

const client = {
  session: { serverUrl: 'https://x.example' },
  api: { agentData: { appWebPath: (wf: string, slug: string) => `/app/${wf}/${slug}` } },
}

test('내 앱 — 사이트·앱은 그 주소를 로그인과 함께, 옛 화면은 웹의 앱 화면을', () => {
  const site = myAppTarget(client, { workflow_id: 'wf', slug: 'map', title: '지도', app_url: '/api/agentflow/agent-apps/wf/map/app/' })
  assert.deepEqual(site?.content, { kind: 'url', url: 'https://x.example/api/agentflow/agent-apps/wf/map/app/', login: true })
  assert.equal(site?.browserUrl, 'https://x.example/app/wf/map', '브라우저로는 웹의 앱 화면')
  const component = myAppTarget(client, { workflow_id: 'wf', slug: 'old', title: '옛 화면', app_url: '' })
  assert.deepEqual(component?.content, { kind: 'url', url: 'https://x.example/app/wf/old', login: true })
})

test('스토어의 앱 — 공개 링크 그대로, 로그인을 싣지 않는다', () => {
  const t = storeAppTarget(client, { path: '/share/app/wf/map/tok', title: '지도', owner_name: '장' } as never)
  assert.deepEqual(t?.content, { kind: 'url', url: 'https://x.example/share/app/wf/map/tok', login: false })
  assert.equal(storeAppTarget(client, { path: 'https://evil.example/x', title: 'x' } as never), null, '다른 출처의 주소는 열지 않는다')
})
