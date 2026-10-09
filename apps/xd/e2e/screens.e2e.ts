/**
 * XD 화면 E2E (M4 완료 기준) — 모든 단계를 **화면 조작으로**. 실제 Electron + 동봉 엔진 + 가짜 LLM(xd_fake).
 *
 * XD_E2E_SHOTS=<폴더> 를 주면 단계마다 화면을 찍어 둔다(눈으로 검토할 때).
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';

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

async function say(win: Page, text: string): Promise<void> {
  await win.getByLabel('메시지').fill(text);
  await win.getByLabel('메시지').press('Enter');
}

/**
 * 시작 화면([새 채팅])에서 새 에이전트의 이름·모델을 적는다. 이름이 없으면 입력창이 잠겨 있고, 누르면 까닭이
 * 보인다. 다 적으면 입력창이 열린다.
 */
async function startNewAgent(win: Page, agentName: string): Promise<void> {
  await win.getByRole('button', { name: '새 채팅' }).click();
  await win.getByRole('heading', { name: '오늘은 무엇을 해볼까요?' }).waitFor();
  assert.equal(await win.getByLabel('메시지').isDisabled(), true);
  await win.getByRole('button', { name: '에이전트 이름을 먼저 입력해 주세요.' }).click();
  await win.getByRole('alert').filter({ hasText: '에이전트 이름을 먼저 입력해 주세요.' }).waitFor();
  await win.getByPlaceholder('예: 리서치 도우미').fill(agentName);
  await win.getByPlaceholder(/모델 이름|모델 목록/).fill('fake-1');
  await win.locator('textarea.composer-input:not([disabled])').waitFor();
}

/** 제공자(시험용) 추가 → 시작 화면에서 새 에이전트로 첫 메시지(화면으로). 보내면 그 에이전트의 새 대화가 열린다. */
async function setUp(win: Page, agentName: string, firstMessage: string): Promise<void> {
  await win.getByText('이 PC 에서 에이전트와 일하세요').waitFor();
  await shot(win, '01-welcome');
  await win.getByRole('button', { name: /AI 제공자 연결/ }).click();
  await win.getByRole('button', { name: '제공자 추가' }).click();
  await win.getByRole('radio', { name: '시험용 모델' }).click();
  await shot(win, '02-add-provider');
  await win.getByRole('button', { name: '추가', exact: true }).click();
  // 계정이 실제로 생겨 목록에 선 뒤에 넘어간다
  await win.locator('.xd-account', { hasText: '시험용 모델' }).waitFor();
  await startNewAgent(win, agentName);
  await shot(win, '03-start');
  await say(win, firstMessage);
  await win.locator('.chat-title-text', { hasText: agentName }).waitFor();
}

/** 시작 화면 → 세부 설정 → [모든 설정]: 연결 폴더·MCP 처럼 시작 화면에 없는 설정으로 에이전트를 만든다. */
async function openFullEditor(win: Page): Promise<void> {
  await win.getByRole('button', { name: '새 채팅' }).click();
  await win.getByText('세부 설정', { exact: true }).click();
  await win.getByRole('button', { name: '모든 설정' }).click();
  await win.getByRole('heading', { name: '새 에이전트' }).waitFor();
}

test('첫 실행부터 대화까지 화면으로, 다시 켜도 대화가 이어진다', { timeout: 240_000 }, async () => {
  const { root, launch } = fixture([
    { text: '보고서를 만들게요.', tools: [{ name: 'Write', input: { file_path: 'report.md', content: '# 보고서\n' } }] },
    { text: '## 정리\n\n`report.md` 를 만들었습니다.\n\n| 항목 | 값 |\n|---|---|\n| 파일 | report.md |' },
  ]);
  let { app, win } = await launch();
  await setUp(win, '리서치 도우미', '보고서 하나 만들어 줘');
  // 답: 작업 과정(도구를 썼다)과 마크다운(표)
  await win.getByText('report.md 를 만들었습니다', { exact: false }).waitFor({ timeout: 60_000 });
  await win.locator('.ptl-head, .ptl-summary, [class*="ptl"]').first().waitFor();
  assert.ok(await win.locator('.bubble.assistant table').count());
  await shot(win, '05-chat-answer');
  assert.equal(readFileSync(join(root, 'workspace', '리서치 도우미', 'report.md'), 'utf8'), '# 보고서\n');
  // 사이드바에 대화가 첫 질문 제목으로(에이전트 이름은 작게) 서고, 채팅 머리에도 그 제목이 보인다
  const row = win.locator('.xd-conv', { hasText: '보고서 하나 만들어 줘' });
  await row.locator('.xd-conv-agent', { hasText: '리서치 도우미' }).waitFor();
  await win.locator('.chat-title-text strong', { hasText: '보고서 하나 만들어 줘' }).waitFor();
  await app.close();

  ({ app, win } = await launch());
  // 다시 켜면 시작 화면이다. 같은 이름의 새 에이전트는 적는 대로 막히고, 있는 에이전트를 고르면 입력창이 열린다
  await win.getByRole('heading', { name: '오늘은 무엇을 해볼까요?' }).waitFor();
  await win.getByPlaceholder('예: 리서치 도우미').fill('리서치 도우미');
  await win.getByText('같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.').waitFor();
  assert.equal(await win.getByLabel('메시지').isDisabled(), true);
  await win.getByRole('button', { name: '에이전트 고르기' }).click();
  await win.getByRole('option', { name: '리서치 도우미' }).click();
  await win.locator('textarea.composer-input:not([disabled])').waitFor();
  await shot(win, '05b-start-existing');
  await win.locator('.xd-conv .conv-name', { hasText: '보고서 하나 만들어 줘' }).click();
  await win.getByText('report.md 를 만들었습니다', { exact: false }).waitFor();
  await say(win, '고마워');
  await win.locator('.msg-row.user .bubble-plain', { hasText: '고마워' }).waitFor();
  await win.waitForFunction(() => document.querySelectorAll('.msg-row.assistant').length === 2, undefined, { timeout: 60_000 });
  await win.locator('.composer-send:not(.stop)').waitFor();
  await shot(win, '06-chat-resumed');

  // 이름 바꾸기: 줄은 제자리에서 바뀌고 머리에도 보인다. 빈 이름이면 첫 질문의 제목으로 돌아간다
  await win.locator('.xd-conv', { hasText: '보고서 하나 만들어 줘' }).getByRole('button', { name: '대화 메뉴' }).click();
  await win.getByRole('menuitem', { name: '이름 바꾸기' }).click();
  await win.getByLabel('대화 이름').fill('내 보고서');
  await win.getByLabel('대화 이름').press('Enter');
  await win.locator('.xd-conv .conv-name', { hasText: '내 보고서' }).waitFor();
  await win.locator('.chat-title-text strong', { hasText: '내 보고서' }).waitFor();
  await win.locator('.xd-conv', { hasText: '내 보고서' }).getByRole('button', { name: '대화 메뉴' }).click();
  await win.getByRole('menuitem', { name: '이름 바꾸기' }).click();
  await win.getByLabel('대화 이름').fill('');
  await win.getByLabel('대화 이름').press('Enter');
  await win.locator('.xd-conv .conv-name', { hasText: '보고서 하나 만들어 줘' }).waitFor();

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
  await setUp(win, '느린 에이전트', '오래 걸리는 일 해 줘');
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
  await win.locator('.xd-conv', { hasText: '느린 에이전트' }).click();
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

  // main 이 만든 계정 하나: 시작 화면(새 에이전트)의 제공자 목록에 Claude Code 가 한 번
  await win.getByRole('button', { name: '새 채팅' }).click();
  await win.getByRole('button', { name: 'AI 제공자 고르기' }).click();
  const options = await win.locator('.selector-opt .selector-opt-label').allTextContents();
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
  await openFullEditor(win);
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

/** 시험용 제공자 하나 — 화면으로. */
async function addFakeProvider(win: Page): Promise<void> {
  await win.getByRole('button', { name: 'AI 제공자', exact: true }).click();
  await win.getByRole('button', { name: '제공자 추가' }).click();
  await win.getByRole('radio', { name: '시험용 모델' }).click();
  await win.getByRole('button', { name: '추가', exact: true }).click();
  await win.locator('.xd-account', { hasText: '시험용 모델' }).waitFor();
}

test('작업 공간 IDE: 에이전트가 쓴 파일을 열어 고쳐 저장하고, 찾고, 연결 폴더도 보이며, 대화는 오른쪽 칸에서 이어진다', { timeout: 240_000 }, async () => {
  const linked = mkdtempSync(join(tmpdir(), 'xd-ide-linked-'));
  writeFileSync(join(linked, 'shared.txt'), 'linked hello\n');
  const { root, launch } = fixture([
    // 턴마다 이름이 다른 파일도 하나 만든다 — IDE 가 열린 채로 턴이 돌면 탐색기가 스스로 다시 읽는지 본다.
    {
      text: '계획을 적을게요.',
      tools: [
        { name: 'Write', input: { file_path: 'notes/plan.md', content: '# 계획\n\nalpha beta\n' } },
        { name: 'Bash', input: { command: 'touch "turn-$(date +%s%N).txt"' } },
      ],
    },
    { text: '`notes/plan.md` 에 적었습니다.' },
  ]);
  let { app, win } = await launch();
  await addFakeProvider(win);
  await openFullEditor(win);
  await win.getByPlaceholder('예: 리서치 도우미').fill('편집 도우미');
  await win.getByPlaceholder(/모델 이름|모델 목록/).fill('fake-1');
  await app.evaluate(({ dialog }, p) => {
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, linked);
  await win.getByRole('button', { name: '폴더 연결' }).click();
  await win.locator('.xd-folder-row', { hasText: linked }).waitFor();
  await win.getByRole('button', { name: '만들기' }).click();
  await say(win, '계획 적어 줘');
  await win.getByText('notes/plan.md 에 적었습니다', { exact: false }).waitFor({ timeout: 60_000 });

  // [작업 공간 보기] — IDE 가 열리고, 대화는 오른쪽 칸에 그대로 있다
  await win.getByRole('button', { name: '작업 공간 보기' }).click();
  const plan = win.locator('[role="treeitem"][data-path="notes/plan.md"]');
  const notes = win.locator('[role="treeitem"][data-path="notes"]');
  await notes.waitFor({ timeout: 30_000 });
  if (!(await plan.count())) await notes.click();
  await plan.click();
  // 마크다운은 그린 쪽(미리보기 — Dex 의 뷰어)부터 보인다
  await win.locator('.fv-root', { hasText: 'alpha beta' }).waitFor({ timeout: 30_000 });
  await shot(win, '15-ide-preview');
  await win.getByRole('button', { name: '편집', exact: true }).click();
  const editor = win.locator('.monaco-editor').first();
  await editor.waitFor({ timeout: 60_000 });
  await win.locator('.monaco-editor .view-lines', { hasText: 'alpha beta' }).waitFor();
  // XD 에 없는 소스 제어·터미널 단추는 없다
  assert.equal(await win.getByRole('button', { name: '소스 제어' }).count(), 0);
  assert.equal(await win.getByRole('button', { name: '터미널', exact: true }).count(), 0);
  await shot(win, '16-ide-editor');

  // 고쳐서 저장(Ctrl+S) → 디스크의 파일이 바뀐다
  await win.locator('.monaco-editor .view-lines').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('gamma\n');
  await win.keyboard.press('Control+s');
  const file = join(root, 'workspace', '편집 도우미', 'notes', 'plan.md');
  for (let i = 0; i < 50 && !readFileSync(file, 'utf8').includes('gamma'); i += 1) await win.waitForTimeout(100);
  assert.equal(readFileSync(file, 'utf8'), '# 계획\n\nalpha beta\ngamma\n');

  // 오류의 까닭(코드·자세한 값)이 화면까지 온다 — 큰 파일은 "너무 크다" 와 그 크기를 보인다(코드를 잃으면 일반 실패 문구).
  writeFileSync(join(root, 'workspace', '편집 도우미', 'big.log'), Buffer.alloc(11 * 1024 * 1024, 0x61));
  await win.getByRole('complementary', { name: '탐색기' }).getByRole('button', { name: '새로 고침' }).first().click();
  const big = win.locator('[role="treeitem"][data-path="big.log"]');
  await big.click();
  await win.getByText(/파일이 너무 커서\(11(\.0)? MB\) 편집기로 열 수 없습니다/).waitFor({ timeout: 30_000 });

  // 연결 폴더 — 탐색기 아래 칸에서 펼쳐 본다
  const folders = win.getByRole('region', { name: '연결된 폴더' });
  await folders.getByText(linked.split(/[\\/]/).pop()!, { exact: true }).click();
  await folders.getByText('shared.txt', { exact: true }).waitFor();

  // 찾기 — 작업 공간 전체에서
  await win.getByRole('button', { name: '찾기', exact: true }).click();
  await win.getByRole('textbox', { name: '찾기' }).fill('alpha');
  await win.locator('.xide-search-file-name', { hasText: 'plan.md' }).waitFor({ timeout: 30_000 });
  await shot(win, '17-ide-search');

  // 대화는 오른쪽 칸에서 이어지고, 그 턴이 만든 파일이 누르지 않아도 탐색기에 나타난다
  await win.getByRole('button', { name: '탐색기', exact: true }).click();
  assert.equal(await win.locator('[role="treeitem"][data-path^="turn-"]').count(), 1);
  await say(win, '한 번 더');
  await win.waitForFunction(() => document.querySelectorAll('.chat-ide-column .msg-row.assistant').length === 2, undefined, { timeout: 60_000 });
  await win.waitForFunction(() => document.querySelectorAll('[role="treeitem"][data-path^="turn-"]').length === 2, undefined, { timeout: 15_000 });
  await app.close();

  // 다시 켜도 그 에이전트는 작업 공간으로, 열어 둔 탭·보기까지 그대로 열린다. 끄면 대화만 남는다.
  ({ app, win } = await launch());
  await win.locator('.xd-conv', { hasText: '편집 도우미' }).first().click();
  await win.locator('.xide-tab', { hasText: 'plan.md' }).waitFor({ timeout: 30_000 });
  await shot(win, '18-ide-restored');
  await win.getByRole('button', { name: '작업 공간 보기' }).click();
  await win.locator('.xide-tab').first().waitFor({ state: 'detached' });
  await win.getByLabel('메시지').waitFor();
  await app.close();
});

test('MCP 서버: 화면에서 붙이고(연결 확인), 턴이 그 도구를 쓰며, 비밀은 DB 에 남지 않고, 못 붙은 서버는 알린다', { timeout: 240_000 }, async () => {
  const py = process.env.XD_ENGINE_PYTHON || join(APP, 'engine', 'dist', `${process.platform}-${process.arch}`, 'python', process.platform === 'win32' ? 'python.exe' : join('bin', 'python3'));
  const demo = join(APP, 'engine', 'tests', 'fakes', 'mcp_demo.py');
  const { root, launch } = fixture([
    { text: '도구를 써 볼게요.', tools: [{ name: 'mcp_demo_where', input: {} }] },
    { text: 'MCP 도구로 확인했습니다.' },
  ]);
  const { app, win } = await launch();
  await addFakeProvider(win);
  await openFullEditor(win);
  await win.getByPlaceholder('예: 리서치 도우미').fill('MCP 도우미');
  await win.getByPlaceholder(/모델 이름|모델 목록/).fill('fake-1');

  // 서버 더하기 → 연결 확인(저장 전 입력으로) → 더하기
  await win.getByRole('button', { name: '서버 더하기' }).click();
  await win.getByPlaceholder('예: GitHub').fill('Demo');
  await win.getByPlaceholder(/server-github/).fill(`"${py}" "${demo}"`);
  await win.getByPlaceholder('GITHUB_TOKEN=…').fill('DEMO_TOKEN=secret-xd-1');
  await win.locator('.xd-mcp-form').getByRole('button', { name: '연결 확인' }).click();
  await win.getByText('연결됨 · 도구 4개').waitFor({ timeout: 90_000 });
  await shot(win, '19-mcp-form');
  await win.getByRole('button', { name: '더하기', exact: true }).click();
  await win.locator('.xd-mcp-row', { hasText: 'Demo' }).waitFor();
  await win.getByRole('button', { name: '만들기' }).click();

  // 턴이 MCP 도구를 쓴다 — 서버는 에이전트 작업 공간에서, 저장한 비밀(env)로 돈다
  await say(win, 'MCP 써 줘');
  await win.getByText('MCP 도구로 확인했습니다.').waitFor({ timeout: 120_000 });
  const db = new DatabaseSync(join(root, '.xd', 'xd.db'), { readOnly: true });
  const rows = db.prepare('SELECT process FROM turns').all() as Array<{ process: string }>;
  const dump = JSON.stringify(db.prepare('SELECT options FROM agents').all());
  db.close();
  const process0 = JSON.parse(rows[0].process) as Array<{ kind: string; event?: { result?: string } }>;
  const where = process0.find((p) => p.kind === 'tool' && String(p.event?.result ?? '').includes('|'))?.event?.result ?? '';
  const [cwd, , token] = String(where).split('|');
  assert.equal(token, 'secret-xd-1');
  assert.equal(realpathSync(cwd), realpathSync(join(root, 'workspace', 'MCP 도우미')));
  // 비밀은 DB 에 없다(키만)
  assert.equal(dump.includes('secret-xd-1'), false);
  assert.ok(dump.includes('DEMO_TOKEN'));

  // 고치기 — 저장된 비밀 값은 다시 보이지 않는다(키만), 못 붙는 서버를 더하면 채팅이 알린다
  await win.getByRole('button', { name: '에이전트 설정' }).click();
  await win.locator('.xd-mcp-row', { hasText: 'Demo' }).getByRole('button', { name: '고치기' }).click();
  assert.equal(await win.getByPlaceholder('GITHUB_TOKEN=…').inputValue(), 'DEMO_TOKEN=');
  await win.getByRole('button', { name: '취소', exact: true }).first().click();
  await win.getByRole('button', { name: '서버 더하기' }).click();
  await win.getByPlaceholder('예: GitHub').fill('Broken');
  await win.getByPlaceholder(/server-github/).fill(join(root, 'no-such-mcp-server'));
  await win.getByRole('button', { name: '더하기', exact: true }).click();
  await win.getByRole('button', { name: '저장' }).click();
  await win.getByLabel('메시지').waitFor();
  await say(win, '한 번 더');
  await win.getByText('MCP 서버(Broken)에 연결하지 못해', { exact: false }).waitFor({ timeout: 120_000 });
  await shot(win, '20-mcp-down');
  await app.close();
});
