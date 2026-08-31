/**
 * TeamsRoomPicker — 방 하나를 고르는 목록.
 *
 * 두 곳이 같은 선택을 한다:
 *   · [Teams로 공유] — 어느 방에 올릴 것인가
 *   · [Teams 대화 붙이기] — 어느 방을 에이전트 문맥으로 줄 것인가
 * 목록·검색·빈 상태 문구가 두 벌로 갈라지지 않도록 여기 하나만 둔다.
 *
 * 자체 모달이 아니라 **목록만** 그린다 — 공유 쪽은 아래에 미리보기가 더 붙고,
 * 문맥 쪽은 붙자마자 닫힌다. 감싸는 모양은 호출자가 정한다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { TeamsRoom } from '../../../core/index';
import { teamsStore, useTeams } from '../teams';
import { ChatIcon, TeamsIcon } from '../brand/icons';
import { filterRooms, roomTime } from './teams-store';

export const TeamsRoomList: React.FC<{
  /** 고른 방 id. 즉시 확정하는 화면(문맥 붙이기)에서는 넘기지 않아도 된다. */
  selectedId?: string;
  onPick: (room: TeamsRoom) => void;
  /** 목록 높이를 키운다 (모달 본문 전체를 쓰는 경우). */
  tall?: boolean;
}> = ({ selectedId, onPick, tall = true }) => {
  const { rooms, loadingRooms } = useTeams();
  const [query, setQuery] = useState('');

  // 목록이 비어 있을 수 있다 — 이 화면이 Teams 탭보다 먼저 열릴 수 있으므로
  // 여기서도 한 번 채운다 (이미 있으면 갱신만 된다).
  useEffect(() => {
    if (rooms.length === 0) void teamsStore.loadRooms();
    // 최초 1회만 — 목록이 비어 있다고 매 렌더 서버를 부르지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => filterRooms(rooms, query), [rooms, query]);

  return (
    <>
      <input
        className="input"
        autoFocus
        value={query}
        placeholder="대화 검색"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className={`teams-user-results ${tall ? 'tall' : ''}`}>
        {loadingRooms && rooms.length === 0 && <div className="teams-empty sm">불러오는 중…</div>}
        {!loadingRooms && visible.length === 0 && (
          <div className="teams-empty sm">
            {rooms.length === 0
              ? '참여 중인 대화가 없습니다. Teams 에서 대화를 먼저 만들어 주세요.'
              : '일치하는 대화가 없습니다.'}
          </div>
        )}
        {visible.map((room) => (
          <button
            key={room.id}
            className={`agent-item ${selectedId === room.id ? 'active' : ''}`}
            onClick={() => onPick(room)}
            title={room.description || room.name}
          >
            <span className="agent-mark">
              {room.isDirect ? <ChatIcon size={16} /> : <TeamsIcon size={16} />}
            </span>
            <span className="agent-body">
              <span className="agent-name">{room.name}</span>
              <span className="agent-meta">
                {room.isDirect ? '1:1 대화' : '그룹 대화'}
                {room.lastMessageAt ? ` · ${roomTime(room.lastMessageAt)}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
};
