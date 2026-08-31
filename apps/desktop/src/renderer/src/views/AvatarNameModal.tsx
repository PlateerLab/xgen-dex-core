/**
 * AvatarNameModal — 아바타 이름 지정/변경 모달 (웹 마이페이지와 동일 흐름).
 *
 *  - mode 'add': 업로드 직후. 미리보기 렌더가 곧 로드 테스트 — 정상 표시를
 *    확인한 뒤 이름을 정해 [추가]. 취소하면 호출부가 업로드 에셋을 정리한다.
 *  - mode 'rename': 목록의 이름 변경.
 *
 * 기본 이름이 기존 이름과 겹치면 "이름 (2)" 식으로 제안한다.
 */
import React, { useMemo, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';
import type { AvatarDescriptor } from '@dex/protocol/preferences';
import { AvatarModel } from '../avatar/Live2DCanvas';

/** 이미 있는 이름이면 "name (2)", "name (3)" … 식으로 빈 자리를 찾는다. */
export function dedupeName(name: string, existing: string[]): string {
  const base = name.trim() || 'avatar';
  const taken = new Set(existing.map((n) => n.trim()));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now() % 1000})`;
}

export const AvatarNameModal: React.FC<{
  avatar: AvatarDescriptor;
  serverUrl: string;
  mode: 'add' | 'rename';
  /** 다른 아바타들의 이름 (자기 자신 제외) — 중복 제안 회피/경고용. */
  existingNames: string[];
  busy?: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}> = ({ avatar, serverUrl, mode, existingNames, busy, onConfirm, onCancel }) => {
  // Esc 로도 닫힌다 (바깥 클릭은 backdrop 이 처리).
  useModalDismiss(onCancel);
  const initial = useMemo(
    () => (mode === 'add' ? dedupeName(avatar.name, existingNames) : avatar.name),
    [mode, avatar.name, existingNames],
  );
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  const duplicate = existingNames.some((n) => n.trim() === trimmed);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{mode === 'add' ? '아바타 확인 및 이름 지정' : '아바타 이름 변경'}</h2>
          <button className="link" onClick={onCancel}>
            닫기
          </button>
        </div>
        {mode === 'add' && (
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            아래 미리보기가 정상적으로 표시되는지 확인한 뒤 이름을 정해 추가하세요.
          </p>
        )}
        <div className="avset-name-preview">
          <AvatarModel key={avatar.id} avatar={avatar} serverUrl={serverUrl} interactive={false} />
        </div>
        <label className="field">
          <span>아바타 이름</span>
          <input
            value={name}
            autoFocus
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed && !busy) onConfirm(trimmed);
            }}
            placeholder="예: 회사 프로필, 엘렌 모델"
          />
          {duplicate && (
            <span className="small notice-warn">
              같은 이름의 아바타가 이미 있습니다. 구분을 위해 다른 이름을 권장합니다.
            </span>
          )}
        </label>
        <div className="avset-modal-actions">
          <button className="secondary" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="primary" onClick={() => onConfirm(trimmed)} disabled={!trimmed || !!busy}>
            {mode === 'add' ? '이 이름으로 추가' : '이름 저장'}
          </button>
        </div>
      </div>
    </div>
  );
};
