/** 앱 전체가 보는 자료 — 앱 정보·계정·에이전트. 바꾼 쪽이 reload 를 부른다. */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { XdInfo } from '../../main/ipc';
import type { XdAgent } from '../../main/store';
import type { AccountView } from '../../main/xd-api';
import { xd } from './bridge';

export interface XdData {
  info: XdInfo | null;
  kinds: string[];
  accounts: AccountView[];
  agents: XdAgent[];
  loaded: boolean;
  error: string;
  reloadAccounts: () => Promise<void>;
  reloadAgents: () => Promise<void>;
}

const Ctx = createContext<XdData | null>(null);

export const DataProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [info, setInfo] = useState<XdInfo | null>(null);
  const [kinds, setKinds] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [agents, setAgents] = useState<XdAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const reloadAccounts = useCallback(async () => setAccounts(await xd.accounts.list()), []);
  const reloadAgents = useCallback(async () => setAgents(await xd.agents.list()), []);

  useEffect(() => {
    Promise.all([xd.info(), xd.accounts.kinds(), xd.accounts.list(), xd.agents.list()])
      .then(([i, k, a, g]) => {
        setInfo(i);
        setKinds(k);
        setAccounts(a);
        setAgents(g);
      })
      .catch((e: unknown) => {
        console.error('[xd] load', e);
        setError('XD 를 시작하지 못했습니다.');
      })
      .finally(() => setLoaded(true));
  }, []);

  // CLI 로그인이 끝나면 main 이 그 계정을 만든다 — 어느 화면에 있든 목록을 다시 읽는다.
  useEffect(
    () =>
      xd.onCliEvent((event) => {
        if (event.type === 'login' && event.event.type === 'done' && event.event.ok) void reloadAccounts();
      }),
    [reloadAccounts],
  );

  return (
    <Ctx.Provider value={{ info, kinds, accounts, agents, loaded, error, reloadAccounts, reloadAgents }}>
      {children}
    </Ctx.Provider>
  );
};

export function useData(): XdData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useData outside DataProvider');
  return v;
}

/** 계정 종류 → 사람이 읽는 이름. */
export const KIND_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai_compatible: 'OpenAI 호환 서버',
  claude_code: 'Claude Code',
  codex: 'Codex',
  xd_fake: '시험용 모델',
};

/** CLI 계정 종류 — 제공자 화면에서 따로 다룬다(설치·로그인). */
export const CLI_KINDS = new Set(['claude_code', 'codex']);

/** 키 없이도 되는 종류(로컬 서버). */
export const KEYLESS_KINDS = new Set(['ollama', 'lmstudio', 'openai_compatible', 'xd_fake']);

/** 주소를 받는 종류와 그 기본값(빈 값이면 필수). */
export const BASE_URL_KINDS: Record<string, string> = {
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  openai_compatible: '',
};

/** 연결 폴더를 받지 않는 까닭(main 의 `folder_<상태>` 코드·폴더 검사 상태). */
/** MCP 서버 설정을 받지 않는 까닭(main 의 `mcp_<…>` 코드). */
export const MCP_TEXT: Record<string, string> = {
  mcp_duplicate: '같은 이름의 MCP 서버가 둘 있습니다.',
  mcp_name: 'MCP 서버에 이름이 없습니다.',
  mcp_command: 'MCP 서버에 실행할 명령이 없습니다.',
  mcp_url: 'MCP 서버 주소는 http 나 https 로 시작해야 합니다.',
  mcp_oauth: 'OAuth 로그인이 필요한 MCP 서버는 아직 쓸 수 없습니다.',
  mcp_bad: 'MCP 서버 설정이 올바르지 않습니다.',
};

export const FOLDER_TEXT: Record<string, string> = {
  folder_inside_xd: 'XD 의 데이터 폴더 안은 연결할 수 없습니다.',
  folder_contains_xd: 'XD 의 데이터 폴더를 품은 폴더는 연결할 수 없으니 그 안의 폴더를 고르세요.',
  folder_relative: '폴더 경로가 올바르지 않습니다.',
  folder_missing: '이 폴더를 찾을 수 없습니다.',
};

/** 연결 폴더 상태 → 목록에 붙는 짧은 표(ok 는 없음). */
export const FOLDER_BADGE: Record<string, string> = {
  missing: '찾을 수 없음',
  relative: '연결할 수 없음',
  inside_xd: '연결할 수 없음',
  contains_xd: '연결할 수 없음',
};

/**
 * 실패 → 사람이 읽는 한 문장. main 이 보내는 글은 개발자용(영어)이라 그대로 보이지 않는다 — 아는 까닭만 풀어 쓰고
 * 나머지는 부르는 쪽이 준 문장으로. 원문은 개발자 도구 콘솔에 남긴다.
 */
export function errorText(e: unknown, fallback: string): string {
  const message = e instanceof Error ? e.message : String(e ?? '');
  const code = (e as { code?: string } | null)?.code;
  console.warn('[xd]', message);
  if (code === 'busy') return '이 대화는 아직 답을 만드는 중입니다.';
  if (code && code in FOLDER_TEXT) return FOLDER_TEXT[code];
  if (code && code in MCP_TEXT) return MCP_TEXT[code];
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|getaddrinfo|network/i.test(message)) {
    return '인터넷에 닿지 않아 마치지 못했습니다.';
  }
  if (/checksum mismatch/i.test(message)) return '받은 파일이 공식 파일과 달라 설치를 멈췄습니다.';
  if (/did not run/i.test(message)) return '받은 프로그램이 이 PC 에서 실행되지 않습니다.';
  if (/not installed/i.test(message)) return '먼저 설치해야 합니다.';
  if (/EACCES|EPERM|permission/i.test(message)) return '폴더에 쓸 권한이 없습니다.';
  return fallback;
}
