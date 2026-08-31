/**
 * TeamsPanel — 사이드바 [Teams] 뷰. 내가 속한 대화방 목록이다.
 *
 *   [Teams]                  ← 제목 줄 + 새 대화 / 새로고침
 *   검색…
 *   ● 팀 회의실        3      ← 안 읽음 배지
 *   ● 홍길동 (1:1)
 *
 * 상태(목록·안 읽음·메시지 캐시)는 이 패널이 아니라 `teamsStore` 가 소유한다 —
 * 메인 영역의 방 탭과 같은 상태를 봐야 하고, 뷰가 [Agent] 로 바뀌어도(패널은
 * 숨겨질 뿐 언마운트되지 않는다) 목록과 스크롤이 유지돼야 하기 때문이다.
 *
 * 여기서 만드는 방은 항상 **사람끼리만**(router_mode='chat') 이다. 에이전트를
 * 붙이는 것은 후속 단계이고 서버가 이미 지원한다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { xgen } from '../bridge';
import { teamsStore, useTeams } from '../teams';
import { notificationStore, useNotifications } from '../notifications';
import type { TeamsMessage, TeamsRoom, TeamsUser } from '@dex/protocol';
import { badgeText, filterRooms, messagePreview, roomTime } from './teams-store';
import { useModalDismiss, useOutsideDismiss } from './use-modal-dismiss';
import {
  BellIcon,
  BellOffIcon,
  ChatIcon,
  LogoutIcon,
  MoreIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TeamsIcon,
  UserPlusIcon,
} from '../brand/icons';

type Mode = 'list' | 'newRoom' | 'newDm';

export const TeamsPanel: React.FC<{
  /** 현재 열려 있는 방 탭 (활성 표시용). */
  activeRoomId: string | null;
  onOpenRoom: (room: TeamsRoom) => void;
  /** 나가기·강퇴·자동 정리로 목록에서 사라진 방의 열린 탭을 닫는다. */
  onRoomRemoved: (roomId: string) => void;
}> = ({ activeRoomId, onOpenRoom, onRoomRemoved }) => {
  const { rooms, loadingRooms, roomsError, unread, byRoom } = useTeams();
  const notificationSnapshot = useNotifications();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('list');
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menuRoomId, setMenuRoomId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties>({});
  const [renamingRoom, setRenamingRoom] = useState<TeamsRoom | null>(null);

  // 사용자 검색 (1:1 대화 상대 고르기).
  const [userQuery, setUserQuery] = useState('');
  const [users, setUsers] = useState<TeamsUser[]>([]);
  const [searching, setSearching] = useState(false);

  /** 펼쳐진 폼과 그것을 여는 버튼들 — 바깥 클릭 판정의 '안쪽' 범위. */
  const formRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const previousRoomIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    void teamsStore.loadRooms();
  }, []);

  // WS 제거 이벤트는 스토어에서 방을 즉시 걷는다. 목록에서 실제로 사라진 순간
  // 같은 방을 띄운 Workspace 탭도 닫아 삭제된 대화가 계속 보이지 않게 한다.
  useEffect(() => {
    const current = new Set(rooms.map((room) => room.id));
    const previous = previousRoomIdsRef.current;
    if (previous) {
      for (const roomId of previous) {
        if (!current.has(roomId)) onRoomRemoved(roomId);
      }
    }
    previousRoomIdsRef.current = current;
  }, [rooms, onRoomRemoved]);

  // 초대 이벤트가 네트워크 전환/절전 사이에 유실돼도 수동 새로고침 없이 복구한다.
  // 정상 경로는 사용자 WS 가 즉시 rooms_changed 를 보내고, 이 주기는 안전망이다.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void teamsStore.loadRooms({ background: true });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, []);

  // 입력을 멈춘 뒤에만 검색한다 — 글자마다 서버를 부르지 않는다.
  useEffect(() => {
    if (mode !== 'newDm') return;
    const q = userQuery.trim();
    if (!q) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void xgenSearch(q)
        .then((found) => {
          if (!cancelled) setUsers(found);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [userQuery, mode]);

  const visible = useMemo(() => filterRooms(rooms, query), [rooms, query]);

  const resetForms = useCallback(() => {
    setMode('list');
    setDraftName('');
    setUserQuery('');
    setUsers([]);
    setError('');
  }, []);

  // 인라인 폼에는 모달의 backdrop 이 없다. 바깥 클릭과 Esc 로 같은 감각을 만든다.
  // 여는 버튼을 '안쪽' 에 포함해야 토글이 정상 동작한다(안 그러면 닫기와 열기가
  // 같이 일어나 한 번 눌러서는 열리지 않는다).
  useOutsideDismiss([formRef, actionsRef], resetForms, mode !== 'list');
  useModalDismiss(resetForms, mode !== 'list');
  useModalDismiss(() => setMenuRoomId(null), menuRoomId !== null);

  const leaveRoom = useCallback(async (room: TeamsRoom) => {
    setMenuRoomId(null);
    setError('');
    const ok = await teamsStore.leave(room.id);
    if (ok) {
      void notificationStore.setScope('teamsRoom', room.id, false);
      return;
    }
    setError(teamsStore.getSnapshot().byRoom[room.id]?.error || '대화방을 나가지 못했습니다.');
  }, []);

  const createRoom = useCallback(async () => {
    const name = draftName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    try {
      const room = await xgen.teams.createRoom(name);
      await teamsStore.loadRooms();
      resetForms();
      onOpenRoom(room);
    } catch (e) {
      setError(e instanceof Error ? e.message : '대화를 만들지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, [draftName, busy, onOpenRoom, resetForms]);

  const startDm = useCallback(
    async (user: TeamsUser) => {
      if (busy) return;
      setBusy(true);
      setError('');
      try {
        const room = await xgen.teams.openDm(user.id, user.username);
        await teamsStore.loadRooms();
        resetForms();
        onOpenRoom(room);
      } catch (e) {
        setError(e instanceof Error ? e.message : '1:1 대화를 열지 못했습니다.');
      } finally {
        setBusy(false);
      }
    },
    [busy, onOpenRoom, resetForms],
  );

  return (
    <>
      <div className="sidebar-title">
        <span className="sidebar-title-text">Teams</span>
        <div className="sidebar-title-actions" ref={actionsRef}>
          <button
            className="icon-btn sm"
            title="새 대화 만들기"
            aria-label="새 대화 만들기"
            onClick={() => setMode(mode === 'newRoom' ? 'list' : 'newRoom')}
          >
            <PlusIcon size={15} />
          </button>
          <button
            className="icon-btn sm"
            title="1:1 대화 시작"
            aria-label="1:1 대화 시작"
            onClick={() => setMode(mode === 'newDm' ? 'list' : 'newDm')}
          >
            <UserPlusIcon size={15} />
          </button>
          <button
            className="icon-btn sm"
            title="목록 새로고침"
            aria-label="목록 새로고침"
            onClick={() => void teamsStore.loadRooms()}
          >
            <RefreshIcon size={14} />
          </button>
        </div>
      </div>

      {mode === 'newRoom' && (
        <div className="teams-form" ref={formRef}>
          <input
            className="input"
            autoFocus
            value={draftName}
            placeholder="대화 이름 (예: 3팀 잡담)"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void createRoom();
              if (e.key === 'Escape') resetForms();
            }}
          />
          <div className="teams-form-row">
            <span className="teams-form-hint">사람끼리만 대화하는 방으로 만들어집니다.</span>
            <button className="secondary sm" onClick={resetForms}>
              취소
            </button>
            <button
              className="sm"
              disabled={!draftName.trim() || busy}
              onClick={() => void createRoom()}
            >
              {busy ? '만드는 중…' : '만들기'}
            </button>
          </div>
        </div>
      )}

      {mode === 'newDm' && (
        <div className="teams-form" ref={formRef}>
          <input
            className="input"
            autoFocus
            value={userQuery}
            placeholder="이름 또는 아이디로 사람 찾기"
            onChange={(e) => setUserQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && resetForms()}
          />
          <div className="teams-user-results">
            {searching && <div className="teams-empty sm">찾는 중…</div>}
            {!searching && userQuery.trim() && users.length === 0 && (
              <div className="teams-empty sm">일치하는 사용자가 없습니다.</div>
            )}
            {users.map((user) => (
              <button
                key={user.id}
                className="agent-item"
                disabled={busy}
                onClick={() => void startDm(user)}
              >
                <span className="teams-avatar">{initial(user.fullName || user.username)}</span>
                <span className="agent-body">
                  <span className="agent-name">{user.fullName || user.username}</span>
                  <span className="agent-meta">@{user.username}</span>
                </span>
              </button>
            ))}
          </div>
          <span className="teams-form-hint">
            바깥을 클릭하거나 <kbd>Esc</kbd> 를 누르면 닫힙니다.
          </span>
        </div>
      )}

      {error && <div className="teams-error">{error}</div>}

      <div className="sidebar-search">
        <input
          className="input"
          value={query}
          placeholder="대화 검색"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="agent-list">
        {loadingRooms && rooms.length === 0 && <div className="teams-empty">불러오는 중…</div>}
        {roomsError && <div className="teams-error">{roomsError}</div>}
        {!loadingRooms && !roomsError && rooms.length === 0 && (
          <div className="teams-empty">
            <TeamsIcon size={30} />
            <p>아직 참여 중인 대화가 없습니다.</p>
            <p className="sub">위의 + 로 새 대화를 만들거나, 사람을 찾아 1:1 대화를 시작하세요.</p>
          </div>
        )}
        {visible.map((room) => {
          const count = unread[room.id] ?? 0;
          const badge = badgeText(count);
          const menuOpen = menuRoomId === room.id;
          const muted = !!notificationSnapshot.profile.mutedTeamsRooms[room.id];
          return (
            <div
              key={room.id}
              className={`agent-item teams-room-item ${activeRoomId === room.id ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
            >
              <button
                className="teams-room-open"
                onClick={() => onOpenRoom(room)}
                title={room.description || room.name}
              >
                <span className="agent-mark">
                  {room.isDirect ? <ChatIcon size={16} /> : <TeamsIcon size={16} />}
                </span>
                <span className="agent-body">
                  <span className="agent-name">{room.name}</span>
                  <span className="agent-meta">
                    {/* 마지막 메시지를 아는 방은 그 한 줄을 보여 준다 — 공유된
                        산출물은 출처 표식을 걷어낸 본문으로 나온다. 아직 열어 본
                        적 없는 방은 캐시가 없으므로 종류·시각만 남는다. */}
                    {preview(byRoom[room.id]?.messages) ||
                      (room.isDirect ? '1:1 대화' : '그룹 대화')}
                    {room.lastMessageAt ? ` · ${roomTime(room.lastMessageAt)}` : ''}
                  </span>
                </span>
                {badge && <span className="teams-badge">{badge}</span>}
              </button>
              <div className="teams-menu-wrap teams-room-item-menu">
                <button
                  className="icon-btn sm teams-room-menu-trigger"
                  title="대화방 설정"
                  aria-label={`${room.name} 대화방 설정`}
                  aria-expanded={menuOpen}
                  onClick={(event) => {
                    if (menuOpen) {
                      setMenuRoomId(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    const menuWidth = 176;
                    const gap = 4;
                    const left = Math.max(
                      8,
                      Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
                    );
                    const opensUp = rect.bottom + 190 > window.innerHeight;
                    setMenuPosition(
                      opensUp
                        ? {
                            left,
                            right: 'auto',
                            top: 'auto',
                            bottom: window.innerHeight - rect.top + gap,
                          }
                        : {
                            left,
                            right: 'auto',
                            top: rect.bottom + gap,
                            bottom: 'auto',
                          },
                    );
                    setMenuRoomId(room.id);
                  }}
                >
                  <MoreIcon size={16} />
                </button>
                {menuOpen &&
                  createPortal(
                    <>
                      <div className="teams-menu-scrim" onClick={() => setMenuRoomId(null)} />
                      <div
                        className="teams-menu teams-room-floating-menu"
                        role="menu"
                        style={menuPosition}
                      >
                        <button
                          onClick={() => {
                            setMenuRoomId(null);
                            setRenamingRoom(room);
                          }}
                        >
                          <PencilIcon size={13} /> 이름 바꾸기
                        </button>
                        <button
                          onClick={() => {
                            setMenuRoomId(null);
                            void notificationStore.setScope(
                              'teamsRoom',
                              room.id,
                              !muted,
                              room.name,
                            );
                          }}
                        >
                          {muted ? <BellIcon size={14} /> : <BellOffIcon size={14} />}
                          {muted ? '알림 켜기' : '알림 끄기'}
                        </button>
                        <div className="teams-menu-sep" />
                        <button className="danger" onClick={() => void leaveRoom(room)}>
                          <LogoutIcon size={14} /> 대화방 나가기
                        </button>
                      </div>
                    </>,
                    document.body,
                  )}
              </div>
            </div>
          );
        })}
      </div>

      {renamingRoom && (
        <RenameRoomModal
          key={renamingRoom.id}
          initial={renamingRoom.name}
          onClose={() => setRenamingRoom(null)}
          onSubmit={async (name) => {
            const ok = await teamsStore.rename(renamingRoom.id, name);
            if (ok) setRenamingRoom(null);
          }}
        />
      )}
    </>
  );
};

const RenameRoomModal: React.FC<{
  initial: string;
  onClose: () => void;
  onSubmit: (name: string) => void | Promise<void>;
}> = ({ initial, onClose, onSubmit }) => {
  useModalDismiss(onClose);
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const changed = name.trim().length > 0 && name.trim() !== initial.trim();

  const submit = useCallback(async () => {
    if (!changed || busy) return;
    setBusy(true);
    await onSubmit(name);
    setBusy(false);
  }, [changed, busy, name, onSubmit]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(event) => event.stopPropagation()}>
        <h3>대화방 이름 바꾸기</h3>
        <input
          className="input"
          autoFocus
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
          }}
        />
        <p className="teams-ctx-confirm-sub">
          바뀐 이름은 이 화면에 바로 반영됩니다. 다른 사람은 Teams 를 다시 열 때 보입니다.
        </p>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="primary" onClick={() => void submit()} disabled={!changed || busy}>
            {busy ? '바꾸는 중…' : '이름 바꾸기'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** 방 목록 한 줄 미리보기 — 캐시된 마지막 메시지가 있을 때만. */
function preview(messages: TeamsMessage[] | undefined): string {
  if (!messages || messages.length === 0) return '';
  return messagePreview(messages[messages.length - 1]);
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || 'U';
}

/** 검색 실패는 빈 결과로 — 오타 한 번에 폼이 죽지 않게 한다. */
function xgenSearch(query: string): Promise<TeamsUser[]> {
  return xgen.teams.searchUsers(query).catch(() => []);
}
