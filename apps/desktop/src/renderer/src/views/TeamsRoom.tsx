/**
 * TeamsRoom — 메인 영역의 [Teams] 탭 본문. 한 방의 대화를 그린다.
 *
 *   ┌ 방 이름 · 멤버 N명 ───── [멤버] [초대] ┐
 *   │  지난 메시지 (위로 스크롤 시 더 불러옴)  │
 *   │  … 홍길동 님이 입력 중                  │
 *   ├ ↩ 답장 대상 / 📎 올릴 파일 ─────────────┤
 *   └ 입력창 ──────────────── [📎] [전송] ────┘
 *
 * 에이전트 채팅(`Chat.tsx`)과 같은 CSS 어휘(msg-row / bubble / composer)를 쓰되,
 * **여러 사람**이 말한다는 점이 다르다: 내 말은 오른쪽, 남의 말은 왼쪽에 이름과
 * 함께 놓고, 같은 사람이 연달아 말하면 머리(아바타·이름)를 한 번만 그린다.
 *
 * 본문 렌더링이 발신자에 따라 갈린다:
 *   · 사람이 친 글 → **평문**. 마크다운으로 재해석하면 `*별표*` 같은 입력이
 *     멋대로 바뀐다.
 *   · 에이전트 답변 / 에이전트에서 공유된 산출물 → **마크다운**. 표·코드블록이
 *     날것으로 보이면 산출물을 공유하는 의미가 없다.
 *
 * 서버에는 **메시지 삭제 API 가 없다** (`message_controller` 에 DELETE 없음).
 * 그래서 보내기 전 확인이 다른 화면보다 중요하다 — 잘못 보낸 것은 편집으로만
 * 수습할 수 있고, 첨부는 그조차 안 된다.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { teamsStore, useTeams, type ReplyTarget } from '../teams';
import { notificationStore, useNotifications } from '../notifications';
import {
  parseSharedMessage,
  type CurrentUser,
  type TeamsAttachment,
  type TeamsMember,
  type TeamsMessage,
  type TeamsRoom as Room,
  type TeamsShareRef,
  type TeamsUser,
} from '@dex/protocol';
import {
  formatBytes,
  isPending,
  isPreviewableImage,
  messageTime,
  startsGroup,
} from './teams-store';
import { Markdown } from './Markdown';
import { useModalDismiss } from './use-modal-dismiss';
import {
  BellIcon,
  BellOffIcon,
  BotIcon,
  CloseIcon,
  DocIcon,
  DownloadIcon,
  PaperclipIcon,
  PencilIcon,
  ReplyIcon,
  SendIcon,
  SmileIcon,
  TeamsIcon,
  UserPlusIcon,
} from '../brand/icons';

/** 빠른 리액션 — 자주 쓰는 것만. 이모지 전체 팔레트는 이번 범위 밖. */
const QUICK_REACTIONS = ['👍', '✅', '🙏', '🎉', '👀'];

/** 인용 미리보기에 남길 길이. 넘으면 잘라 붙인다. */
const QUOTE_MAX = 120;

export const TeamsRoom: React.FC<{
  room: Room;
  user: CurrentUser;
  /** 공유된 산출물의 [원본 대화 보기] — 그 에이전트 대화를 탭으로 연다. */
  onOpenSource?: (ref: TeamsShareRef) => void;
}> = ({ room, user, onOpenSource }) => {
  const snapshot = useTeams();
  const notificationSnapshot = useNotifications();
  const state = snapshot.byRoom[room.id];
  const messages = state?.messages ?? [];
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [reactFor, setReactFor] = useState<string | null>(null);
  /** 답장 대상 — 붙어 있으면 composer 위에 인용 배너가 뜬다. */
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  /** 올렸지만 아직 전송하지 않은 첨부. 전송 시 함께 나간다. */
  const [staged, setStaged] = useState<TeamsAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  /** 편집 중인 내 메시지 id. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /** 사용자가 위쪽 과거를 보고 있으면 새 메시지가 와도 강제로 내리지 않는다. */
  const stickToBottomRef = useRef(true);
  const typingSentAtRef = useRef(0);

  const myId = user.userId;
  const myName = user.username || '나';

  // 방이 바뀌면 소켓을 갈아끼우고 메시지를 불러온다. 탭을 닫는 것은 Workspace 가
  // closeRoom 으로 알린다 — 여기서는 "보고 있는 방" 만 관리한다.
  useEffect(() => {
    stickToBottomRef.current = true;
    // 방을 옮기면 이전 방의 답장·첨부 대기 상태를 들고 가지 않는다.
    setReplyTo(null);
    setStaged([]);
    setEditingId(null);
    setInput('');
    void teamsStore.openRoom(room.id);
    teamsStore.markRead(room.id);
    return () => {
      // 다른 방으로 이동 — 이 방은 더 이상 보고 있지 않다.
      teamsStore.closeRoom(room.id);
    };
  }, [room.id]);

  // 새 메시지가 오면 맨 아래로. 단, 사용자가 과거를 보고 있으면 건드리지 않는다.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, state?.typing, staged.length, replyTo]);

  // 보고 있는 동안 도착한 메시지는 즉시 읽은 것으로 친다.
  useEffect(() => {
    if (messages.length > 0) teamsStore.markRead(room.id);
  }, [room.id, messages.length]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
    // 맨 위에 닿으면 과거를 더 불러온다. 불러온 뒤 스크롤 위치는 브라우저가
    // 유지해 주지 않으므로 높이 차이만큼 되돌린다.
    if (el.scrollTop < 40 && state?.hasMore && !state.loadingMore) {
      const before = el.scrollHeight;
      void teamsStore.loadOlder(room.id).then(() => {
        const after = scrollRef.current;
        if (after) after.scrollTop = after.scrollHeight - before;
      });
    }
  }, [room.id, state?.hasMore, state?.loadingMore]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && staged.length === 0) || sending) return;
    setSending(true);
    setInput('');
    stickToBottomRef.current = true;
    const ok = await teamsStore.send(room.id, text, myName, {
      replyTo: replyTo ?? undefined,
      attachments: staged,
    });
    if (ok) {
      setReplyTo(null);
      setStaged([]);
    } else {
      // 실패하면 입력을 되돌려 준다 — 사용자가 친 글자를 잃게 하지 않는다.
      // 첨부는 이미 서버에 올라가 있으므로 그대로 두면 재전송이 그냥 된다.
      setInput(text);
    }
    setSending(false);
    taRef.current?.focus();
  }, [input, staged, sending, room.id, myName, replyTo]);

  const attach = useCallback(async () => {
    if (uploading) return;
    setUploading(true);
    const added = await teamsStore.pickAttachments(room.id);
    setUploading(false);
    if (added.length > 0) setStaged((current) => [...current, ...added]);
    taRef.current?.focus();
  }, [room.id, uploading]);

  /** 타이핑 신호는 3초에 한 번만 — 글자마다 보내면 소켓이 시끄럽다. */
  const signalTyping = useCallback(() => {
    const now = Date.now();
    if (now - typingSentAtRef.current < 3_000) return;
    typingSentAtRef.current = now;
    void xgen.teams.typing(room.id, true);
  }, [room.id]);

  const typingNames = useMemo(
    () => Object.values(state?.typing ?? {}).filter(Boolean),
    [state?.typing],
  );

  const memberCount = state?.members.length ?? 0;
  const onlineCount = state?.members.filter((m) => m.isOnline).length ?? 0;
  const canSend = (input.trim().length > 0 || staged.length > 0) && !sending;

  return (
    <div className="chat teams-room">
      <div className="chat-header">
        <div className="chat-title">
          <span className="agent-mark">
            <TeamsIcon size={17} />
          </span>
          <div className="chat-title-text">
            <strong>{room.name}</strong>
            <div className="agent-meta">
              {room.isDirect ? '1:1 대화' : `멤버 ${memberCount}명`}
              {onlineCount > 0 && ` · 접속 중 ${onlineCount}명`}
              {state && !state.connected && ' · 연결 끊김'}
            </div>
          </div>
        </div>
        <div className="chat-header-actions">
          <button
            className="secondary teams-members-button"
            onClick={() => {
              setMembersOpen(true);
              void teamsStore.refreshMembers(room.id);
            }}
            title="현재 대화 멤버 보기"
          >
            <TeamsIcon size={15} /> {memberCount > 0 ? `멤버 ${memberCount}` : '멤버'}
          </button>
          <button className="secondary" onClick={() => setInviteOpen(true)} title="대화 상대 초대">
            <UserPlusIcon size={15} /> 초대
          </button>
        </div>
      </div>

      {state && !state.connected && (
        <div className="teams-banner" role="status">
          실시간 연결이 끊어졌습니다. 자동으로 다시 연결합니다 — 그동안 보낸 메시지는 저장됩니다.
        </div>
      )}
      {state?.error && <div className="teams-error inline">{state.error}</div>}

      <div className="chat-log" ref={scrollRef} onScroll={onScroll}>
        {state?.loadingMore && <div className="teams-empty sm">이전 대화를 불러오는 중…</div>}
        {state?.loading && messages.length === 0 && (
          <div className="chat-empty">
            <p>대화를 불러오는 중…</p>
          </div>
        )}
        {!state?.loading && messages.length === 0 && (
          <div className="chat-empty">
            <TeamsIcon size={44} className="mark" />
            <h3>{room.name}</h3>
            <p>첫 메시지를 보내 대화를 시작하세요.</p>
          </div>
        )}
        {messages.map((message, index) => (
          <MessageRow
            key={message.id}
            roomId={room.id}
            message={message}
            previous={messages[index - 1]}
            myId={myId}
            reacting={reactFor === message.id}
            editing={editingId === message.id}
            onToggleReact={() => setReactFor(reactFor === message.id ? null : message.id)}
            onReact={(emoji) => {
              setReactFor(null);
              void teamsStore.toggleReaction(room.id, message.id, emoji);
            }}
            onReply={() => {
              setReplyTo(replyTargetOf(message));
              taRef.current?.focus();
            }}
            onStartEdit={() => setEditingId(message.id)}
            onCancelEdit={() => setEditingId(null)}
            onSubmitEdit={async (text) => {
              const ok = await teamsStore.edit(room.id, message.id, text);
              if (ok) setEditingId(null);
            }}
            senderNotificationMuted={
              !!notificationSnapshot.profile.mutedTeamsSenders[message.senderId]
            }
            onToggleSenderNotification={() =>
              void notificationStore.setScope(
                'teamsSender',
                message.senderId,
                !notificationSnapshot.profile.mutedTeamsSenders[message.senderId],
                message.senderName,
              )
            }
            onOpenSource={onOpenSource}
          />
        ))}
      </div>

      <div className="chat-input">
        {typingNames.length > 0 && (
          <div className="teams-typing" role="status">
            {typingNames.join(', ')} 님이 입력 중…
          </div>
        )}

        {replyTo && (
          <div className="teams-reply-bar">
            <ReplyIcon size={13} />
            <span className="who">{replyTo.senderName}</span>
            <span className="quote">{clip(replyTo.content)}</span>
            <button onClick={() => setReplyTo(null)} title="답장 취소" aria-label="답장 취소">
              <CloseIcon size={12} />
            </button>
          </div>
        )}

        {staged.length > 0 && (
          <div className="teams-staged">
            {staged.map((file) => (
              <span className="teams-staged-item" key={file.id}>
                <DocIcon size={12} />
                <span className="name" title={file.filename}>
                  {file.filename}
                </span>
                <span className="size">{formatBytes(file.size)}</span>
                <button
                  onClick={() => setStaged((current) => current.filter((f) => f.id !== file.id))}
                  title="첨부 빼기"
                  aria-label="첨부 빼기"
                >
                  <CloseIcon size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer">
          <textarea
            ref={taRef}
            className="composer-input"
            value={input}
            placeholder={`${room.name}에 메시지 보내기…`}
            onChange={(e) => {
              setInput(e.target.value);
              signalTyping();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                setReplyTo(null);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            spellCheck={false}
          />
          <button
            className="composer-shot"
            onClick={() => void attach()}
            disabled={uploading}
            title={uploading ? '올리는 중…' : '파일 첨부'}
            aria-label="파일 첨부"
          >
            <PaperclipIcon size={16} />
          </button>
          <button
            className="composer-send"
            onClick={() => void send()}
            disabled={!canSend}
            title="전송"
            aria-label="전송"
          >
            <SendIcon size={17} />
          </button>
        </div>
        <div className="composer-foot">
          <span className="kbd-hint">
            <kbd>Enter</kbd> 전송 · <kbd>Shift + Enter</kbd> 줄바꿈
          </span>
        </div>
      </div>

      {membersOpen && (
        <MembersModal
          roomName={room.name}
          members={state?.members ?? []}
          loading={state?.membersLoading ?? false}
          error={state?.membersError ?? ''}
          myUserId={myId}
          onRefresh={() => void teamsStore.refreshMembers(room.id)}
          onClose={() => setMembersOpen(false)}
        />
      )}

      {inviteOpen && <InviteModal roomId={room.id} onClose={() => setInviteOpen(false)} />}
    </div>
  );
};

/** 현재 방의 사람 목록. 접속 중인 사람을 먼저 보여 주고 내 계정을 표시한다. */
const MembersModal: React.FC<{
  roomName: string;
  members: TeamsMember[];
  loading: boolean;
  error: string;
  myUserId: string;
  onRefresh: () => void;
  onClose: () => void;
}> = ({ roomName, members, loading, error, myUserId, onRefresh, onClose }) => {
  useModalDismiss(onClose);
  const sorted = useMemo(
    () =>
      [...members].sort((a, b) => {
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        const an = a.fullName || a.username;
        const bn = b.fullName || b.username;
        return an.localeCompare(bn);
      }),
    [members],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal teams-members-modal" onClick={(event) => event.stopPropagation()}>
        <div className="teams-members-head">
          <div>
            <h3>대화 멤버</h3>
            <p>
              {roomName} · {members.length}명
            </p>
          </div>
          <div className="teams-members-actions">
            <button className="secondary sm" onClick={onRefresh} disabled={loading}>
              {loading ? '불러오는 중…' : '새로고침'}
            </button>
            <button className="icon-btn sm" onClick={onClose} title="닫기" aria-label="닫기">
              <CloseIcon size={15} />
            </button>
          </div>
        </div>
        {error && <div className="teams-error inline">{error}</div>}
        <div className="teams-members-list">
          {loading && members.length === 0 && (
            <div className="teams-empty sm">멤버를 불러오는 중…</div>
          )}
          {!loading && members.length === 0 && (
            <div className="teams-empty sm">표시할 멤버가 없습니다.</div>
          )}
          {sorted.map((member) => {
            const name = member.fullName || member.username;
            const mine = String(member.userId) === myUserId;
            return (
              <div className="teams-member-row" key={member.userId}>
                <span className="teams-avatar">{name.trim().charAt(0).toUpperCase() || 'U'}</span>
                <span className="teams-member-body">
                  <span className="teams-member-name">
                    {name} {mine && <span className="teams-member-me">나</span>}
                  </span>
                  <span className="teams-member-account">@{member.username}</span>
                </span>
                <span className={`teams-member-presence ${member.isOnline ? 'online' : ''}`}>
                  <span className="dot" /> {member.isOnline ? '접속 중' : '오프라인'}
                </span>
                {member.role !== 'member' && (
                  <span className="teams-member-role">
                    {member.role === 'owner' ? '방장' : '관리자'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** 답장 배너·인용에 쓸 짧은 발췌. */
function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > QUOTE_MAX ? `${one.slice(0, QUOTE_MAX)}…` : one;
}

/**
 * 답장 대상으로 삼을 값. 공유 메시지는 **표식을 걷어낸 본문**을 인용한다 —
 * `⟨xgen:…⟩` 태그가 인용 미리보기에 그대로 나오면 읽을 수 없다.
 */
function replyTargetOf(message: TeamsMessage): ReplyTarget {
  const shared = parseSharedMessage(message.content);
  return {
    id: message.id,
    senderName: shared ? shared.ref.label : message.senderName,
    content: shared ? shared.body : message.content,
  };
}

const MessageRow: React.FC<{
  roomId: string;
  message: TeamsMessage;
  previous: TeamsMessage | undefined;
  myId: string;
  reacting: boolean;
  editing: boolean;
  onToggleReact: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void | Promise<void>;
  senderNotificationMuted: boolean;
  onToggleSenderNotification: () => void;
  onOpenSource?: (ref: TeamsShareRef) => void;
}> = ({
  roomId,
  message,
  previous,
  myId,
  reacting,
  editing,
  onToggleReact,
  onReact,
  onReply,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  senderNotificationMuted,
  onToggleSenderNotification,
  onOpenSource,
}) => {
  const mine = message.senderType === 'user' && message.senderId === myId;
  const head = startsGroup(message, previous);
  const pending = isPending(message);
  // 공유된 산출물이면 표식을 떼고, 본문은 에이전트 글이므로 마크다운으로 그린다.
  const shared = useMemo(() => parseSharedMessage(message.content), [message.content]);
  const body = shared ? shared.body : message.content;
  const asMarkdown = Boolean(shared) || message.senderType === 'agent';

  // 시스템 안내(입장/퇴장)는 말풍선이 아니라 가운데 한 줄로.
  if (message.senderType === 'system') {
    return <div className="teams-system">{message.content}</div>;
  }

  return (
    <div className={`msg-row ${mine ? 'user' : 'assistant'} ${head ? '' : 'grouped'}`}>
      {!mine &&
        (head ? (
          <div className="teams-avatar" title={message.senderName}>
            {message.senderType === 'agent' ? (
              <BotIcon size={15} />
            ) : (
              message.senderName.trim().charAt(0).toUpperCase() || 'U'
            )}
          </div>
        ) : (
          <div className="teams-avatar spacer" aria-hidden />
        ))}
      <div className="msg-col">
        {!mine && head && <div className="teams-sender">{message.senderName}</div>}

        {/* 답장 인용 — 무엇에 답한 것인지가 본문보다 먼저 보여야 한다. */}
        {message.replyToId && (message.replyToContent || message.replyToSenderName) && (
          <div className="teams-quote">
            <ReplyIcon size={11} />
            <span className="who">{message.replyToSenderName || '알 수 없음'}</span>
            <span className="text">{clip(message.replyToContent ?? '')}</span>
          </div>
        )}

        {/* 공유 출처 카드 — 커넥터에서만 보이는 부분. 웹 Teams 는 같은 정보를
            본문 첫 줄의 문장으로 읽는다. */}
        {shared && (
          <div className="teams-share-card">
            <span className="teams-share-from">
              {shared.ref.kind === 'file' ? <DocIcon size={12} /> : <BotIcon size={13} />}
              {shared.ref.label}
              <span className="sub">
                {shared.ref.kind === 'file' ? '워크스페이스 파일' : '에이전트 답변'}
              </span>
            </span>
            {shared.ref.kind === 'agent' && shared.ref.workflowId && shared.ref.interactionId && (
              <button className="link" onClick={() => onOpenSource?.(shared.ref)}>
                원본 대화 보기
              </button>
            )}
          </div>
        )}

        {editing ? (
          <EditBox initial={body} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
        ) : (
          body && (
            <div className={`bubble ${mine ? 'user' : 'assistant'} ${pending ? 'pending' : ''}`}>
              {asMarkdown ? <Markdown text={body} /> : <span className="bubble-plain">{body}</span>}
            </div>
          )
        )}

        {message.attachments && message.attachments.length > 0 && (
          <div className="teams-attachments">
            {message.attachments.map((file) => (
              <AttachmentCard key={file.id || file.storageKey} roomId={roomId} file={file} />
            ))}
          </div>
        )}

        {/* 반응은 시간·액션 행보다 메시지에 가깝게 둔다. 액션 행은 투명할 때도
            높이를 차지하므로 그 뒤에 두면 반응이 다음 메시지에 붙어 보인다. */}
        {message.reactions && message.reactions.length > 0 && (
          <div className="teams-reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                className={`teams-reaction ${
                  reaction.userIds.includes(Number(myId)) ? 'mine' : ''
                }`}
                onClick={() => onReact(reaction.emoji)}
                title={`${reaction.count}명`}
              >
                <span>{reaction.emoji}</span>
                <span className="count">{reaction.count}</span>
              </button>
            ))}
          </div>
        )}

        {!editing && (
          <div className="teams-meta-row">
            <span className="teams-time">{messageTime(message.createdAt)}</span>
            {message.isEdited && <span className="teams-edited">편집됨</span>}
            {pending && <span className="teams-edited">보내는 중…</span>}
            {/* 아직 서버가 모르는 메시지에는 행동을 걸 수 없다 — id 가 임시값이다. */}
            {!pending && (
              <>
                <button
                  className="teams-react-btn"
                  title="답장"
                  aria-label="답장"
                  onClick={onReply}
                >
                  <ReplyIcon size={13} />
                </button>
                <button
                  className="teams-react-btn"
                  title="반응 남기기"
                  aria-label="반응 남기기"
                  onClick={onToggleReact}
                >
                  <SmileIcon size={13} />
                </button>
                {/* 편집은 서버가 본인 메시지만 허용한다 — 남의 것에는 버튼도 안 띄운다. */}
                {mine && (
                  <button
                    className="teams-react-btn"
                    title="편집"
                    aria-label="편집"
                    onClick={onStartEdit}
                  >
                    <PencilIcon size={12} />
                  </button>
                )}
                {!mine && (
                  <button
                    className="teams-react-btn"
                    title={
                      senderNotificationMuted
                        ? `${message.senderName}의 Teams 알림 켜기`
                        : `${message.senderName}의 Teams 알림 끄기`
                    }
                    aria-label={senderNotificationMuted ? '발신자 알림 켜기' : '발신자 알림 끄기'}
                    onClick={onToggleSenderNotification}
                  >
                    {senderNotificationMuted ? <BellOffIcon size={12} /> : <BellIcon size={12} />}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {reacting && (
          <div className="teams-react-picker" role="menu">
            {QUICK_REACTIONS.map((emoji) => (
              <button key={emoji} onClick={() => onReact(emoji)} title={emoji}>
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/** 내 메시지 인라인 편집. Enter 저장 / Esc 취소 — 채팅에서 기대되는 그대로. */
const EditBox: React.FC<{
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void | Promise<void>;
}> = ({ initial, onCancel, onSubmit }) => {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // 커서를 끝으로 — 고치려고 들어왔는데 전체가 선택돼 있으면 한 글자만 쳐도 다 날아간다.
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = useCallback(async () => {
    const next = text.trim();
    if (!next || busy) return;
    if (next === initial.trim()) {
      onCancel();
      return;
    }
    setBusy(true);
    await onSubmit(next);
    setBusy(false);
  }, [text, busy, initial, onSubmit, onCancel]);

  return (
    <div className="teams-edit">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
        spellCheck={false}
      />
      <div className="teams-edit-actions">
        <span className="kbd-hint">
          <kbd>Enter</kbd> 저장 · <kbd>Esc</kbd> 취소
        </span>
        <button className="secondary sm" onClick={onCancel} disabled={busy}>
          취소
        </button>
        <button className="sm" onClick={() => void submit()} disabled={!text.trim() || busy}>
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
};

/**
 * 첨부 한 개. 그림은 미리보기로, 나머지는 파일 카드로 그린다.
 *
 * 미리보기 이미지도 **바이트를 IPC 로 받아** blob URL 로 만든다. 서버 주소를
 * `<img src>` 에 그대로 박으면 인증 헤더가 실리지 않아 401 이 되고, 토큰을
 * 쿼리에 실으면 그 URL 이 캐시·로그에 남는다.
 */
const AttachmentCard: React.FC<{ roomId: string; file: TeamsAttachment }> = ({ roomId, file }) => {
  const [busy, setBusy] = useState<'' | 'open' | 'save'>('');
  const [note, setNote] = useState('');

  const run = useCallback(
    async (what: 'open' | 'save') => {
      if (busy) return;
      setBusy(what);
      setNote('');
      try {
        if (what === 'open') await xgen.teams.openAttachment(roomId, file);
        else {
          const path = await xgen.teams.saveAttachment(roomId, file);
          if (path) setNote('저장했습니다');
        }
      } catch (e) {
        setNote(e instanceof Error ? e.message : '실패했습니다');
      } finally {
        setBusy('');
      }
    },
    [busy, roomId, file],
  );

  if (isPreviewableImage(file)) {
    return (
      <ImageAttachment roomId={roomId} file={file} onFallbackAction={run} busy={busy} note={note} />
    );
  }

  return (
    <div className="teams-file">
      <span className="teams-file-mark">
        <DocIcon size={14} />
      </span>
      <span className="teams-file-body">
        <span className="teams-file-name" title={file.filename}>
          {file.filename}
        </span>
        <span className="teams-file-meta">
          {formatBytes(file.size)}
          {file.truncated && ' · 본문 일부만 색인됨'}
          {note && ` · ${note}`}
        </span>
      </span>
      <span className="teams-file-actions">
        <button onClick={() => void run('open')} disabled={!!busy} title="열기">
          {busy === 'open' ? '여는 중…' : '열기'}
        </button>
        <button onClick={() => void run('save')} disabled={!!busy} title="다른 이름으로 저장">
          <DownloadIcon size={13} />
        </button>
      </span>
    </div>
  );
};

/**
 * 그림 첨부 — 인라인 미리보기.
 *
 * 바이트를 IPC 로 받아 blob URL 로 감싼다. 서버 주소를 `<img src>` 에 그대로
 * 박으면 렌더러 요청에 Authorization 헤더가 실리지 않아 401 이 되고, 토큰을
 * 쿼리에 실으면 그 URL 이 캐시·로그에 남는다.
 *
 * 못 불러오면 파일 카드로 조용히 물러난다 — 방의 대화가 깨진 그림 아이콘으로
 * 덮이는 것보다 낫다.
 */
const ImageAttachment: React.FC<{
  roomId: string;
  file: TeamsAttachment;
  busy: '' | 'open' | 'save';
  note: string;
  onFallbackAction: (what: 'open' | 'save') => void;
}> = ({ roomId, file, busy, note, onFallbackAction }) => {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = '';
    let alive = true;
    void xgen.teams
      .readAttachment(roomId, file)
      .then((bytes) => {
        if (!alive) return;
        // Uint8Array 가 더 큰 버퍼 위의 뷰일 수 있다(IPC) — 이 파일의 바이트만 담는다.
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        revoked = URL.createObjectURL(new Blob([buf], { type: file.mime }));
        setUrl(revoked);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      // blob URL 은 명시적으로 놓아주지 않으면 창이 닫힐 때까지 메모리에 남는다.
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [roomId, file.storageKey, file.mime]);

  if (failed) {
    return (
      <div className="teams-file">
        <span className="teams-file-mark">
          <DocIcon size={14} />
        </span>
        <span className="teams-file-body">
          <span className="teams-file-name" title={file.filename}>
            {file.filename}
          </span>
          <span className="teams-file-meta">
            {formatBytes(file.size)} · 미리보기를 불러오지 못했습니다
            {note && ` · ${note}`}
          </span>
        </span>
        <span className="teams-file-actions">
          <button onClick={() => onFallbackAction('save')} disabled={!!busy}>
            <DownloadIcon size={13} />
          </button>
        </span>
      </div>
    );
  }

  return (
    <figure className="teams-image">
      {url ? (
        <img src={url} alt={file.filename} onClick={() => onFallbackAction('open')} />
      ) : (
        <div className="teams-image-loading">불러오는 중…</div>
      )}
      <figcaption>
        <span className="name" title={file.filename}>
          {file.filename}
        </span>
        <span className="size">
          {formatBytes(file.size)}
          {note && ` · ${note}`}
        </span>
        <button
          onClick={() => onFallbackAction('save')}
          disabled={!!busy}
          title="다른 이름으로 저장"
        >
          <DownloadIcon size={13} />
        </button>
      </figcaption>
    </figure>
  );
};

/** 초대 — 사용자를 찾아 방에 추가한다. 서버가 시스템 메시지를 broadcast 한다. */
const InviteModal: React.FC<{ roomId: string; onClose: () => void }> = ({ roomId, onClose }) => {
  useModalDismiss(onClose);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<TeamsUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void xgen.teams
        .searchUsers(q)
        .then((found) => {
          if (!cancelled) setUsers(found);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const invite = useCallback(
    async (user: TeamsUser) => {
      setBusy(true);
      setError('');
      try {
        await xgen.teams.addMember(roomId, user.id);
        // 서버 확정 뒤 같은 목록을 다시 읽어 헤더 인원수와 멤버 목록을 즉시 맞춘다.
        await teamsStore.refreshMembers(roomId);
        setDone((current) => [...current, user.username]);
      } catch (e) {
        setError(e instanceof Error ? e.message : '초대하지 못했습니다.');
      } finally {
        setBusy(false);
      }
    },
    [roomId],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal teams-invite" onClick={(e) => e.stopPropagation()}>
        <h3>대화 상대 초대</h3>
        <input
          className="input"
          autoFocus
          value={query}
          placeholder="이름 또는 아이디로 찾기"
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <div className="teams-error inline">{error}</div>}
        <div className="teams-user-results tall">
          {users.map((user) => {
            const invited = done.includes(user.username);
            return (
              <button
                key={user.id}
                className="agent-item"
                disabled={busy || invited}
                onClick={() => void invite(user)}
              >
                <span className="teams-avatar">
                  {(user.fullName || user.username).trim().charAt(0).toUpperCase()}
                </span>
                <span className="agent-body">
                  <span className="agent-name">{user.fullName || user.username}</span>
                  <span className="agent-meta">@{user.username}</span>
                </span>
                {invited && <span className="teams-badge done">초대됨</span>}
              </button>
            );
          })}
          {query.trim() && users.length === 0 && (
            <div className="teams-empty sm">일치하는 사용자가 없습니다.</div>
          )}
        </div>
        <p className="modal-hint">
          바깥을 클릭하거나 <kbd>Esc</kbd> 를 누르면 닫힙니다.
        </p>
      </div>
    </div>
  );
};
