/**
 * 기기의 폴더 장부 ↔ 서버의 대화 폴더 사본 — 데스크톱·모바일이 같은 규칙을 쓴다.
 *
 * 폴더는 대화의 속성이고 물리적으로는 기기 하나에 있다. 장부가 원본이고, 서버는 사본을
 * 들고 **어느 화면에서든** 그것을 보이고 쓰게 한다(웹·휴대폰·다른 PC 에서 보낸 턴도 이
 * 기기의 폴더 도구를 쓴다). 여기서 하는 일:
 *
 *   올리기   폴더를 연결·해제하면 서버에 올린다. 다른 기기에 폴더가 있는 대화면 서버가
 *            거절한다(other_device) — 화면이 [이 기기로 옮기기] 를 묻는다.
 *   맞추기   켜질 때(로그인) 장부 전체를 올리고, 그 사이 다른 기기로 **옮겨 간** 대화는 잊는다.
 *   따르기   다른 기기가 이 기기의 대화를 옮겨 갔다는 알림(대화 버스 `folders`)을 받으면 잊는다.
 *
 * 서버가 시켜서 잊는 것은 다시 올리지 않는다(메아리가 되면 다른 기기의 연결을 덮는다).
 * 옛 서버(API 없음)면 아무것도 하지 않는다 — 예전처럼 요청에 실린 폴더만 쓴다.
 *
 * 기기마다 폴더 모양이 다르다(데스크톱은 절대 경로, 모바일은 content:// URI 와 가상 경로) —
 * 장부와 `wire`(서버에 올리는 모양)만 기기가 준다.
 */
import type {
  ConversationFolderDeviceInfo,
  ConversationFolderUpload,
  ConversationFoldersApi,
  ConversationFoldersPutResult,
  ConversationFoldersState,
} from './conversation-folders';

export interface FolderLedger<F> {
  list(interactionId: string): F[];
  set(interactionId: string, folders: F[]): unknown;
  forget(interactionId: string): void;
  entries(): { interactionId: string; folders: F[] }[];
  accountId(): string | null;
}

type FoldersApiLike = Pick<ConversationFoldersApi, 'get' | 'put' | 'reconcile'>;

export interface ConversationFolderSyncDeps<F> {
  api: () => FoldersApiLike | null;
  ledger: FolderLedger<F>;
  device: () => ConversationFolderDeviceInfo;
  /** 장부의 폴더 → 서버에 올리는 모양(경로는 에이전트가 쓰는 경로). */
  wire: (folders: F[]) => ConversationFolderUpload[];
  log?: (message: string) => void;
}

export class ConversationFolderSync<F> {
  /** 서버가 시켜서 바꾸는 중인 대화 — 그 변화는 다시 올리지 않는다. */
  private quiet = new Set<string>();
  private reconciledAccount: string | null = null;

  constructor(protected deps: ConversationFolderSyncDeps<F>) {}

  /** 이 변화가 서버에서 온 것인가(올리지 말 것). */
  isQuiet(interactionId: string): boolean {
    return this.quiet.has(interactionId);
  }

  /** 이 대화의 서버 사본(다른 기기의 폴더·켜짐 여부). 옛 서버·실패면 null. */
  async state(interactionId: string): Promise<ConversationFoldersState | null> {
    const api = this.deps.api();
    if (!api) return null;
    try {
      return await api.get(interactionId);
    } catch {
      return null;
    }
  }

  /** 장부의 지금 목록을 올린다. */
  async publish(
    interactionId: string,
    opts: { takeOver?: boolean; folders?: F[] } = {},
  ): Promise<ConversationFoldersPutResult | null> {
    const api = this.deps.api();
    if (!api) return null;
    const folders = opts.folders ?? this.deps.ledger.list(interactionId);
    try {
      return await api.put(interactionId, this.deps.device(), this.deps.wire(folders), {
        takeOver: opts.takeOver,
      });
    } catch (error) {
      this.deps.log?.(`[chat-folders] 서버에 올리지 못했습니다: ${String(error)}`);
      return null;
    }
  }

  /**
   * 폴더를 더하기 **전에** 서버에 묻는다 — 다른 기기에 폴더가 있으면 더하지 않고 그 사실을 돌려준다.
   * 서버에 닿지 않으면(옛 서버·오프라인) 더한다: 이 기기의 일은 막지 않는다.
   */
  async add(
    interactionId: string,
    next: F[],
    opts: { takeOver?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; state: ConversationFoldersState }> {
    const result = await this.publish(interactionId, { folders: next, takeOver: opts.takeOver });
    if (result && !result.ok && result.code === 'other_device') return { ok: false, state: result.state };
    this.quietly(interactionId, () => this.deps.ledger.set(interactionId, next));
    return { ok: true };
  }

  /** 켜질 때(로그인·계정 전환) 한 번 — 장부 전체를 올리고 옮겨 간 대화는 잊는다. */
  async reconcile(force = false): Promise<void> {
    const account = this.deps.ledger.accountId();
    const api = this.deps.api();
    if (!account || !api) return;
    if (!force && this.reconciledAccount === account) return;
    this.reconciledAccount = account;
    let out: { drop: string[] } | null = null;
    try {
      out = await api.reconcile(
        this.deps.device(),
        this.deps.ledger.entries().map((entry) => ({
          interactionId: entry.interactionId,
          folders: this.deps.wire(entry.folders),
        })),
      );
    } catch (error) {
      this.reconciledAccount = null; // 다음 기회에 다시
      this.deps.log?.(`[chat-folders] 서버와 맞추지 못했습니다: ${String(error)}`);
      return;
    }
    for (const interactionId of out?.drop ?? []) this.forgetQuietly(interactionId);
  }

  /**
   * 대화 버스의 `folders` — 어느 기기가 이 대화의 폴더를 가졌는가. 다른 기기가 가져갔는데
   * 이 기기 장부에 남아 있으면 잊는다(옮겨 갔다). 잊었으면 true.
   */
  onServerFolders(state: ConversationFoldersState): boolean {
    const mine = this.deps.device().deviceId;
    if (!state.interactionId || !state.device || state.device.deviceId === mine) return false;
    if (!state.folders.length) return false;
    if (!this.deps.ledger.list(state.interactionId).length) return false;
    this.forgetQuietly(state.interactionId);
    return true;
  }

  private forgetQuietly(interactionId: string): void {
    this.quietly(interactionId, () => this.deps.ledger.forget(interactionId));
  }

  private quietly<T>(interactionId: string, task: () => T): T {
    this.quiet.add(interactionId);
    try {
      return task();
    } finally {
      this.quiet.delete(interactionId);
    }
  }
}
