/**
 * 사이드바: 대화 목록(ChatGPT·Claude 처럼 대화 단위, 마지막으로 말한 순서). 맨 위 [새 채팅] 은 시작 화면을 연다.
 *
 * 한 줄 = 에이전트 이름(작게) + 대화 제목(붙인 이름, 없으면 첫 질문, 둘 다 없으면 "새 대화"). 도는 대화에는 표시가
 * 붙는다(Dex 사이드바와 같은 CSS). 줄마다 [⋯] 메뉴로 [이름 바꾸기]·[삭제](웹·Dex 와 같은 자리). 이름을 바꿔도 줄은 제자리에 있다.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { XdConversationListItem } from '../../../main/store';
import { xd } from '../bridge';
import { errorText } from '../data';
import { MoreIcon, PlusIcon } from '../dex';
import { useRunning } from '../live-store';
import { conversationTitle, dropConversation, replaceConversation } from '../start-model';

/** 이름 바꾸기 칸. Enter·칸 밖으로 나가면 저장, Esc 는 그만두기. 빈 이름이면 첫 질문의 제목으로 돌아간다. */
const RenameInput: React.FC<{ initial: string; onDone: (title: string | null) => void }> = ({ initial, onDone }) => {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      className="xd-conv-rename"
      autoFocus
      value={value}
      maxLength={200}
      aria-label="대화 이름"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
};

export const Sidebar: React.FC<{
  conversations: XdConversationListItem[];
  loaded: boolean;
  onConversations: (update: (list: XdConversationListItem[]) => XdConversationListItem[]) => void;
  /** 열려 있는 대화(없으면 null). */
  conversationId: string | null;
  /** 시작 화면이 열려 있는가([새 채팅] 이 눌린 모양). */
  starting: boolean;
  onNewChat: () => void;
  onOpenConversation: (agentId: string, conversationId: string) => void;
  onDeleted: (conversationId: string) => void;
}> = ({ conversations, loaded, onConversations, conversationId, starting, onNewChat, onOpenConversation, onDeleted }) => {
  const running = useRunning();
  const [renaming, setRenaming] = useState<string | null>(null);
  /** [⋯] 메뉴가 열린 대화. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 목록 아래쪽 줄이면 메뉴를 위로 펼친다(아래로 펼치면 목록 칸에 잘린다). */
  const [menuUp, setMenuUp] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 메뉴 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.conv-menu-wrap')) setMenuFor(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuFor]);

  // 이름을 바꾸던 대화가 목록에서 빠지면(지워짐) 칸도 닫는다.
  useEffect(() => {
    if (renaming && !conversations.some((c) => c.id === renaming)) setRenaming(null);
  }, [conversations, renaming]);

  const rename = (c: XdConversationListItem, title: string | null) => {
    setRenaming(null);
    if (title === null || title.trim() === c.title.trim()) return;
    xd.conversations
      .rename(c.id, title)
      .then((updated) => onConversations((list) => replaceConversation(list, updated)))
      .catch((err) => window.alert(errorText(err, '대화 이름을 바꾸지 못했습니다.')));
  };

  const remove = (c: XdConversationListItem) => {
    if (!window.confirm('이 대화를 지울까요?')) return;
    xd.conversations
      .remove(c.id)
      .then(() => {
        onConversations((list) => dropConversation(list, c.id));
        onDeleted(c.id);
      })
      .catch((err) => window.alert(errorText(err, '대화를 지우지 못했습니다.')));
  };

  return (
    <aside className="sidebar xd-sidebar">
      <div className="side-panel">
        <div className="sidebar-title">
          <span className="sidebar-title-text">대화</span>
        </div>
        <div className="xd-side-top">
          <button type="button" className={`conv-item xd-new-chat${starting ? ' active' : ''}`} onClick={onNewChat}>
            <span className="conv-icon">
              <PlusIcon size={14} />
            </span>
            <span className="conv-body">
              <div className="conv-name">새 채팅</div>
            </span>
          </button>
        </div>
        {/*
          에이전트를 가리지 않는 한 목록. XD 는 에이전트를 지우면 그 대화도 함께 지운다(store 의 ON DELETE CASCADE).
          그래서 웹·Dex 의 [지워짐] 상태도, 지워진 에이전트의 대화를 치우는 동작도 XD 에는 없다.
        */}
        {loaded && conversations.length === 0 && <div className="muted small pad">아직 대화가 없습니다.</div>}
        <div className="xd-conv-list" role="list" aria-label="대화 목록" ref={listRef}>
          {conversations.map((c) => {
            const live = running.includes(c.id);
            const title = conversationTitle(c);
            const open = () => onOpenConversation(c.agentId, c.id);
            if (renaming === c.id) {
              return (
                <div key={c.id} role="listitem" className={`conv-item xd-conv editing${c.id === conversationId ? ' active' : ''}`}>
                  <span className="conv-body">
                    <div className="xd-conv-agent">{c.agentName}</div>
                    <RenameInput initial={c.title} onDone={(t) => rename(c, t)} />
                  </span>
                </div>
              );
            }
            return (
              <div
                key={c.id}
                role="listitem"
                className={`conv-item xd-conv${c.id === conversationId ? ' active' : ''}`}
                tabIndex={0}
                title={title}
                onClick={open}
                onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open()}
              >
                <span className="conv-body">
                  <div className="xd-conv-agent">
                    {c.agentName}
                    {live && ' · 답을 만드는 중'}
                  </div>
                  <div className="conv-name">
                    {live && <span className="live-dot live" />}
                    {title}
                  </div>
                </span>
                <span className={`xd-conv-actions conv-menu-wrap${menuFor === c.id ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="xd-conv-act"
                    title="대화 메뉴"
                    aria-label="대화 메뉴"
                    aria-expanded={menuFor === c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      const button = e.currentTarget.getBoundingClientRect();
                      const list = listRef.current?.getBoundingClientRect();
                      setMenuUp(!!list && list.bottom - button.bottom < 96);
                      setMenuFor((m) => (m === c.id ? null : c.id));
                    }}
                  >
                    <MoreIcon size={14} />
                  </button>
                  {menuFor === c.id && (
                    <div className={`conv-menu${menuUp ? ' up' : ''}`} role="menu" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        role="menuitem"
                        className="conv-menu-item"
                        onClick={() => {
                          setMenuFor(null);
                          setRenaming(c.id);
                        }}
                      >
                        이름 바꾸기
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="conv-menu-item danger"
                        disabled={live}
                        title={live ? '답을 만드는 중에는 지울 수 없습니다.' : undefined}
                        onClick={() => {
                          setMenuFor(null);
                          remove(c);
                        }}
                      >
                        삭제
                      </button>
                    </div>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
