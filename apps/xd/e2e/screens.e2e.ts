/**
 * XD 화면 E2E (M4 완료 기준) — 모든 단계를 **화면 조작으로**. 실제 Electron + 동봉 엔진 + 가짜 LLM(xd_fake).
 *
 * XD_E2E_SHOTS=<폴더> 를 주면 단계마다 화면을 찍어 둔다(눈으로 검토할 때).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const APP = resolve(__dirname, '..');
const ELECTRON = createRequire(__filename)('electron') as string;
const SHOTS = process.env.XD_E2E_SHOTS;

/** 띄운 앱은 시험이 실패해도 닫는다 — 남으면 node 가 끝나지 않는다. */
const opened: ElectronApplication[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close().catch(() => undefined);
});

function fixture(responses: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'xd-screens-root-'));
  const script = join(mkdtempSync(join(tmpdir(), 'xd-screens-tmp-')), 'script.json');
  writeFileSync(script, JSON.stringify({ responses }));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), XD_DATA_ROOT: root, XD_ENGINE_FAKE_LLM: script };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async (): Promise<{ app: ElectronApplication; win: Page }> => {
    const app = await _electron.launch({ executablePath: ELECTRON, args: [APP, '--no-sandbox'], env });
    opened.push(app);
    app.once('close', () => {
      const i = opened.indexOf(app);
      if (i >= 0) opened.splice(i, 1);
    });
    const win = await app.firstWindow();
    await win.setViewportSize({ width: 1280, height: 800 });
    return { app, win };
  };
  return { root, launch };
}

async function shot(win: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await win.waitForTimeout(250);
  await win.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** 제공자(시험용) 추가 → 에이전트 만들기 — 화면으로. */
async function setUp(win: Page, agentName: string): Promise<void> {
  await win.getByText('이 PC 에서 에이전트와 일하세요').waitFor();
  await shot(win, '01-welcome');
  await win.getByRole('button', { name: /AI 제공자 연결/ }).click();
  await win.getByRole('button', { name: '제공자 추가' }).click();
  await win.getByRole('radio', { name: '시험용 모델' }).click();
  await shot(win, '02-add-provider');
  await win.getByRole('button', { name: '추가', exact: true }).click();
  // 계정이 실제로 생겨 목록에 선 뒤에 넘어간다
  await win.locator('.xd-account', { hasText: '시험용 모델' }).waitFor();
  await win.getByRole('button', { name: '새 에이전트' }).click();
  await win.getByPlaceholder('예: 리서치 도우미').fill(agentName);
  await win.getByPlaceholder(/모델 이름|모델 목록/).fill('fake-1');
  await shot(win, '03-agent-new');
  await win.getByRole('button', { name: '만들기' }).click();
  await win.getByLabel('메시지').waitFor();
}

async function say(win: Page, text: string): Promise<void> {
  await win.getByLabel('메시지').fill(text);
  await win.getByLabel('메시지').press('Enter');
}

test('첫 실행부터 대화까지 화면으로, 다시 켜도 대화가 이어진다', { timeout: 240_000 }, async () => {
  const { root, launch } = fixture([
    { text: '보고서를 만들게요.', tools: [{ name: 'Write', input: { file_path: 'report.md', content: '# 보고서\n' } }] },
    { text: '## 정리\n\n`report.md` 를 만들었습니다.\n\n| 항목 | 값 |\n|---|---|\n| 파일 | report.md |' },
  ]);
  let { app, win } = await launch();
  await setUp(win, '리서치 도우미');
  await shot(win, '04-chat-empty');
  await say(win, '보고서 하나 만들어 줘');
  // 답: 작업 과정(도구를 썼다)과 마크다운(표)
  await win.getByText('report.md 를 만들었습니다', { exact: false }).waitFor({ timeout: 60_000 });
  await win.locator('.ptl-head, .ptl-summary, [class*="ptl"]').first().waitFor();
  assert.ok(await win.locator('.bubble.assistant table').count());
  await shot(win, '05-chat-answer');
  assert.equal(readFileSync(join(root, 'workspace', '리서치 도우미', 'report.md'), 'utf8'), '# 보고서\n');
  // 사이드바에 대화가 첫 질문 제목으로 선다
  await win.locator('.conv-name', { hasText: '보고서 하나 만들어 줘' }).waitFor();
  await app.close();

  ({ app, win } = await launch());
  await win.getByText('리서치 도우미').first().click();
  await win.locator('.conv-name', { hasText: '보고서 하나 만들어 줘' }).click();
  await win.getByText('report.md 를 만들었습니다', { exact: false }).waitFor();
  await say(win, '고마워');
  await win.locator('.msg-row.user .bubble-plain', { hasText: '고마워' }).waitFor();
  await win.waitForFunction(() => document.querySelectorAll('.msg-row.assistant').length === 2, undefined, { timeout: 60_000 });
  await win.locator('.composer-send:not(.stop)').waitFor();
  await shot(win, '06-chat-resumed');

  // 설정: 루트·엔진 상태
  await win.getByRole('button', { name: '설정', exact: true }).click();
  await win.getByText('실행 중입니다.').waitFor();
  await win.getByText(/XD \S+ · 런타임 \S+/).waitFor();
  assert.ok(await win.getByText(root, { exact: false }).count());
  await shot(win, '07-settings');
  await app.close();
});

test('정지하면 중단된 답으로 남고, 제공자가 없으면 까닭이 보인다', { timeout: 240_000 }, async () => {
  const { launch } = fixture([{ text: '오래 걸리는 일을 합니다.', tools: [{ name: 'Bash', input: { command: 'sleep 30' } }] }, { text: 'never' }]);
  const { app, win } = await launch();
  await setUp(win, '느린 에이전트');
  await say(win, '오래 걸리는 일 해 줘');
  const stop = win.getByRole('button', { name: '정지' });
  await stop.waitFor();
  // 도구가 돌기 시작한 뒤 멈춘다(엔진이 처음 뜨는 시간과 상관없이)
  await win.locator('.ptl-tool.run').waitFor({ timeout: 30_000 });
  await stop.click();
  await win.getByText('작업이 중단되었습니다').waitFor({ timeout: 30_000 });
  await shot(win, '08-chat-stopped');
  assert.equal(await win.getByText('never').count(), 0);

  // 제공자를 지우면 이 에이전트의 다음 턴은 까닭과 함께 실패한다
  await win.getByRole('button', { name: 'AI 제공자', exact: true }).click();
  win.once('dialog', (d) => void d.accept());
  await win.getByRole('button', { name: '제공자 지우기' }).click();
  await win.getByText('아직 연결한 제공자가 없습니다.').waitFor();
  await win.getByText('느린 에이전트').first().click();
  await win.getByText('에이전트 설정에서 AI 제공자를 골라야 대화할 수 있습니다.').waitFor();
  await say(win, '다시 해 줘');
  await win.getByText('이 에이전트에 연결된 AI 제공자가 없습니다.').waitFor({ timeout: 30_000 });
  await shot(win, '09-chat-error');
  await app.close();
});

test('제공자 화면: Claude Code·Codex 상태가 보인다(이 PC 에 있으면 설치됨)', { timeout: 120_000 }, async () => {
  const { launch } = fixture([]);
  const { app, win } = await launch();
  await win.getByRole('button', { name: 'AI 제공자', exact: true }).click();
  for (const name of ['Claude Code', 'Codex']) {
    const card = win.locator('.xd-cli', { has: win.getByRole('heading', { name, exact: true }) });
    await card.locator('.xd-cli-line').first().waitFor();
    const text = await card.innerText();
    assert.ok(/설치됨|설치되어 있지 않습니다/.test(text), text);
    assert.ok(/설치|업데이트/.test(text), text);
  }
  await shot(win, '10-providers');
  await app.close();
});

test('Claude Code 로그인(가짜 CLI): 화면을 떠났다 와도 이어지고, 몇 번 로그인해도 계정은 하나', { timeout: 120_000, skip: process.platform === 'win32' }, async () => {
  const { root, launch } = fixture([]);
  // XD 가 설치한 자리에 가짜 claude(코드 GOOD#state 면 로그인)를 둔다
  const bin = join(root, '.xd', 'cli', 'claude', 'bin', 'claude');
  mkdirSync(dirname(bin), { recursive: true });
  copyFileSync(resolve(__dirname, '..', 'test', 'fixtures', 'fake-claude.mjs'), bin);
  chmodSync(bin, 0o755);
  const { win } = await launch();
  const providers = () => win.getByRole('button', { name: 'AI 제공자', exact: true }).click();
  await providers();
  const card = win.locator('.xd-cli', { has: win.getByRole('heading', { name: 'Claude Code', exact: true }) });
  await card.getByText('XD 가 설치함').waitFor();

  const login = async () => {
    await card.getByRole('button', { name: '로그인', exact: true }).click();
    await card.getByRole('button', { name: '브라우저에서 로그인 열기' }).waitFor();
    // 로그인 중에 다른 화면에 갔다 와도 주소·코드 칸이 그대로다
    await win.getByRole('button', { name: '설정', exact: true }).click();
    await providers();
    await card.getByRole('button', { name: '브라우저에서 로그인 열기' }).waitFor();
    await shot(win, '11-cli-login');
    await card.getByLabel('로그인 코드').fill('GOOD#state');
    await card.getByRole('button', { name: '확인', exact: true }).click();
    await card.getByText('로그인됨 · me@example.com').waitFor();
  };
  await login();
  await card.getByRole('button', { name: '로그아웃' }).click();
  await card.getByText('XD 에서 아직 로그인하지 않았습니다.').waitFor();
  await login();
  await shot(win, '12-cli-logged-in');

  // main 이 만든 계정 하나 — 새 에이전트의 제공자 목록에 Claude Code 가 한 번
  await win.getByRole('button', { name: '새 에이전트' }).click();
  const options = await win.locator('select option').allTextContents();
  assert.deepEqual(options, ['Claude Code']);
});

test('연결 폴더: 고를 때 바로 검사하고, 에이전트가 그 폴더에 쓰며, 폴더가 없어져도 대화는 이어진다', { timeout: 180_000 }, async () => {
  const linked = mkdtempSync(join(tmpdir(), 'xd-linked-'));
  // 가짜 LLM 은 턴마다 각본을 처음부터 읽는다 — 두 번째 턴도 같은 곳에 쓰려 한다.
  const { root, launch } = fixture([
    { text: '적어 둘게요.', tools: [{ name: 'Write', input: { file_path: join(linked, 'note.md'), content: '# 메모\n' } }] },
    { text: '연결 폴더에 `note.md` 를 적었습니다.' },
  ]);
  const { app, win } = await launch();
  // 폴더 고르기 창은 누를 수 없다 — 차례로 돌려줄 경로를 바꿔 끼운다.
  const pickNext = (path: string) =>
    app.evaluate(({ dialog }, p) => {
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, path);

  await win.getByText('이 PC 에서 에이전트와 일하세요').waitFor();
  await win.getByRole('button', { name: /AI 제공자 연결/ }).click();
  await win.getByRole('button', { name: '제공자 추가' }).click();
  await win.getByRole('radio', { name: '시험용 모델' }).click();
  await win.getByRole('button', { name: '추가', exact: true }).click();
  await win.locator('.xd-account', { hasText: '시험용 모델' }).waitFor();
  await win.getByRole('button', { name: '새 에이전트' }).click();
  await win.getByPlaceholder('예: 리서치 도우미').fill('폴더 도우미');
  await win.getByPlaceholder(/모델 이름|모델 목록/).fill('fake-1');

  // XD 루트(.xd 를 품은 폴더)는 고르는 자리에서 거절된다
  await pickNext(root);
  await win.getByRole('button', { name: '폴더 연결' }).click();
  await win.getByText('XD 의 데이터 폴더를 품은 폴더는 연결할 수 없으니 그 안의 폴더를 고르세요.').waitFor();
  assert.equal(await win.locator('.xd-folder-row').count(), 0);
  await pickNext(linked);
  await win.getByRole('button', { name: '폴더 연결' }).click();
  await win.locator('.xd-folder-row', { hasText: linked }).waitFor();
  await shot(win, '13-linked-pick');
  await win.getByRole('button', { name: '만들기' }).click();
  await win.getByLabel('메시지').waitFor();

  // 머리에 연결 폴더 1개, 에이전트가 그 폴더에 쓴다
  await win.getByRole('button', { name: '연결 폴더 1개' }).waitFor();
  await say(win, '메모 남겨 줘');
  await win.getByText('note.md 를 적었습니다', { exact: false }).waitFor({ timeout: 60_000 });
  assert.equal(readFileSync(join(linked, 'note.md'), 'utf8'), '# 메모\n');

  // 폴더가 없어져도 다음 턴은 끝까지 돈다 — 그 폴더는 빠져서 쓰기가 거부되고(다시 만들지 않는다), 화면은
  // 빼고 답한다고 알린다.
  rmSync(linked, { recursive: true, force: true });
  await win.locator('.composer-send:not(.stop)').waitFor();
  await say(win, '또 해 줘');
  await win.waitForFunction(() => document.querySelectorAll('.msg-row.assistant').length === 2, undefined, { timeout: 60_000 });
  await win.locator('.composer-send:not(.stop)').waitFor({ timeout: 60_000 });
  await win.locator('.msg-row.assistant').nth(1).getByText('실패 1', { exact: false }).waitFor();
  await win.getByText('연결 폴더 중 찾을 수 없는 것은 빼고 답합니다.').waitFor();
  await win.getByRole('button', { name: '연결 폴더 1개' }).click();
  await win.locator('.xd-linked-pop .xd-folder-missing').waitFor();
  await shot(win, '14-linked-missing');
  assert.equal(existsSync(linked), false);
});
