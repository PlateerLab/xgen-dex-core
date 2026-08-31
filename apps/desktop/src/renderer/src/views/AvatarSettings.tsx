/**
 * AvatarSettings — 커넥터 안의 아바타 설정 화면 (웹 마이페이지 [아바타 설정]의
 * 커넥터 네이티브 구현). 사이드바 헤더의 아바타 버튼으로 진입, 메인 페인을
 * 통째로 전환한다 (채팅 세션은 뒤에 그대로 유지).
 *
 *  [설정] 아바타 기능 on/off · 업로드(모델 zip / 사진 크롭) → 미리보기(=로드
 *        테스트) → 이름 지정 → 추가 · 선택/이름 변경/삭제 · 인터랙티브
 *        미리보기(휠/드래그 → 변형 저장, read-modify-write)
 *  [스토어] 공유 아바타 갤러리 · 별점 · 내려받기 · 내 아바타 등록/내리기
 *
 * 모든 config 수정은 main 프로세스의 read-modify-write op 를 타므로 웹/오버레이
 * 와 경합해도 서로를 덮어쓰지 않고, 수정 즉시 오버레이가 갱신된다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';
import { xgen } from '../bridge';
import type { CurrentUser, StoreAvatar } from '@dex/protocol';
import type { AvatarConfig, AvatarDescriptor } from '@dex/protocol/preferences';
import { AvatarModel, type AvatarTransform } from '../avatar/Live2DCanvas';
import { AvatarCropModal } from './AvatarCropModal';
import { AvatarNameModal, dedupeName } from './AvatarNameModal';
import { BackIcon, PencilIcon, TrashIcon, UploadIcon } from '../brand/icons';
import { Selector } from './Selector';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

/** 에셋 URL → main 프로세스 프록시 스킴 (CORS/CSP 무관 로딩). */
function assetUrl(u: string): string {
  if (/^xgenavatar:/.test(u)) return u;
  let path = u;
  if (/^https?:\/\//.test(u)) {
    const p = new URL(u);
    path = p.pathname + p.search;
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return `xgenavatar://a${path}`;
}

const runtimeLabel = (r: string) => (r === 'spine' ? 'Spine' : r === 'image' ? '사진' : 'Live2D');

/** 5-star rating — readonly, or interactive (hover + click). */
const Stars: React.FC<{
  value: number;
  size?: number;
  interactive?: boolean;
  onRate?: (s: number) => void;
}> = ({ value, size = 14, interactive, onRate }) => {
  const [hover, setHover] = useState(0);
  const shown = interactive && hover ? hover : value;
  return (
    <span className="avset-stars" style={{ fontSize: size }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={i <= Math.round(shown) ? 'on' : ''}
          onMouseEnter={interactive ? () => setHover(i) : undefined}
          onMouseLeave={interactive ? () => setHover(0) : undefined}
          onClick={interactive ? () => onRate?.(i) : undefined}
          style={{ cursor: interactive ? 'pointer' : 'default' }}
        >
          ★
        </span>
      ))}
    </span>
  );
};

const StorePreview: React.FC<{ avatar: AvatarDescriptor; serverUrl: string }> = ({
  avatar,
  serverUrl,
}) => {
  if (avatar.runtime === 'image') {
    return <img src={assetUrl(avatar.modelUrl)} alt={avatar.name} className="avset-store-img" />;
  }
  return <AvatarModel key={avatar.id} avatar={avatar} serverUrl={serverUrl} interactive={false} />;
};

// ── publish modal ────────────────────────────────────────────────
const PublishModal: React.FC<{
  myAvatars: AvatarDescriptor[];
  onClose: () => void;
  onPublish: (avatar: AvatarDescriptor, name: string, description: string) => Promise<void>;
}> = ({ myAvatars, onClose, onPublish }) => {
  useModalDismiss(onClose);
  const [selectedId, setSelectedId] = useState(myAvatars[0]?.id ?? '');
  const selected = myAvatars.find((a) => a.id === selectedId) ?? myAvatars[0] ?? null;
  const [name, setName] = useState(selected?.name ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = (id: string) => {
    setSelectedId(id);
    const a = myAvatars.find((x) => x.id === id);
    setName(a?.name ?? '');
  };

  const submit = async () => {
    if (!selected || !name.trim()) return;
    setBusy(true);
    try {
      await onPublish(selected, name.trim(), description.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>스토어에 등록</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="field">
          <span>등록할 아바타</span>
          <Selector
            value={selectedId}
            onChange={pick}
            options={myAvatars.map((a) => ({
              value: a.id,
              label: `${a.name} · ${runtimeLabel(a.runtime)}`,
              keywords: a.name,
            }))}
            searchable={myAvatars.length > 8}
            searchPlaceholder="아바타 검색…"
            ariaLabel="등록할 아바타 선택"
          />
        </div>
        <label className="field">
          <span>이름</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <label className="field">
          <span>설명</span>
          <textarea
            className="avset-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="이 아바타를 소개해 주세요."
          />
        </label>
        <div className="avset-modal-actions">
          <button className="secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || !selected || !name.trim()}
          >
            {busy ? '등록 중…' : '등록'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── main view ────────────────────────────────────────────────────
export const AvatarSettings: React.FC<{
  user: CurrentUser;
  serverUrl: string;
  onBack: () => void;
}> = ({ user, serverUrl, onBack }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'settings' | 'store'>('settings');
  const [config, setConfig] = useState<AvatarConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [pendingAdd, setPendingAdd] = useState<AvatarDescriptor | null>(null);
  const [renaming, setRenaming] = useState<AvatarDescriptor | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AvatarDescriptor | null>(null);
  // 삭제 확인이 떠 있으면 Esc 는 **그것만** 닫는다 (스택의 맨 위가 대상).
  useModalDismiss(() => setConfirmDelete(null), !!confirmDelete);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // store tab
  const [items, setItems] = useState<StoreAvatar[]>([]);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeBusy, setStoreBusy] = useState<string | null>(null);
  const [showPublish, setShowPublish] = useState(false);

  const say = useCallback((kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  }, []);

  useEffect(() => {
    let alive = true;
    xgen.user
      .avatarConfig()
      .then((c) => alive && setConfig(c))
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const avatars = config?.avatars ?? [];
  const selected = config
    ? (avatars.find((a) => a.id === config.defaultAvatarId) ?? avatars[0] ?? null)
    : null;

  /** main 의 read-modify-write op 를 실행하고 반환된 최신 config 를 반영. */
  const run = useCallback(
    async (op: () => Promise<AvatarConfig>, okMsg?: string) => {
      setBusy(true);
      try {
        const next = await op();
        setConfig(next);
        if (okMsg) say('ok', okMsg);
        return true;
      } catch {
        say('err', '저장에 실패했습니다.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [say],
  );

  // ── upload flow ──
  const doUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const descriptor = await xgen.avatars.uploadAsset(bytes, file.name);
        setPendingAdd(descriptor); // → 이름 모달 (미리보기 = 로드 테스트)
      } catch {
        say('err', '아바타 업로드에 실패했습니다.');
      } finally {
        setUploading(false);
      }
    },
    [say],
  );

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const name = file.name.toLowerCase();
      if (IMAGE_RE.test(name)) setCropFile(file);
      else if (name.endsWith('.zip')) void doUpload(file);
      else say('err', '지원하지 않는 형식입니다. (모델 zip 또는 png/jpg 사진)');
    },
    [doUpload, say],
  );

  const confirmAdd = useCallback(
    async (name: string) => {
      const d = pendingAdd;
      if (!d) return;
      setPendingAdd(null);
      await run(() => xgen.avatars.add(d, name), '아바타를 추가했습니다.');
    },
    [pendingAdd, run],
  );

  const cancelAdd = useCallback(() => {
    const d = pendingAdd;
    setPendingAdd(null);
    if (d) xgen.avatars.deleteAsset(d.id).catch(() => undefined); // 고아 에셋 정리
  }, [pendingAdd]);

  // ── list ops ──
  const onSelect = useCallback(
    (id: string) => {
      if (!config || id === config.defaultAvatarId) return;
      void run(() => xgen.avatars.select(id));
    },
    [config, run],
  );

  const confirmRename = useCallback(
    async (name: string) => {
      const target = renaming;
      if (!target) return;
      setRenaming(null);
      await run(() => xgen.avatars.rename(target.id, name));
    },
    [renaming, run],
  );

  const doDelete = useCallback(
    async (avatar: AvatarDescriptor) => {
      setConfirmDelete(null);
      const ok = await run(() => xgen.avatars.remove(avatar.id), '아바타를 삭제했습니다.');
      if (ok) xgen.avatars.deleteAsset(avatar.id).catch(() => undefined);
    },
    [run],
  );

  /** 미리보기 변형 저장 — 대상 id 를 상호작용 시점에 고정 + read-modify-write. */
  const onTransform = useCallback(
    (tf: AvatarTransform) => {
      const id = selected?.id;
      if (!id) return;
      setConfig((c) =>
        c
          ? {
              ...c,
              avatars: c.avatars.map((a) =>
                a.id === id ? { ...a, scale: tf.scale, position: tf.position } : a,
              ),
            }
          : c,
      );
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        xgen.user.saveAvatarTransform?.(id, tf).catch(() => undefined);
      }, 600);
    },
    [selected?.id],
  );

  // ── store ──
  const refreshStore = useCallback(async () => {
    setStoreLoading(true);
    try {
      setItems(await xgen.avatars.storeList());
    } catch {
      say('err', '스토어를 불러오지 못했습니다.');
    } finally {
      setStoreLoading(false);
    }
  }, [say]);

  useEffect(() => {
    if (tab === 'store') void refreshStore();
  }, [tab, refreshStore]);

  const doPublish = useCallback(
    async (avatar: AvatarDescriptor, name: string, description: string) => {
      try {
        await xgen.avatars.storePublish(avatar, name, description);
        await refreshStore();
        say('ok', '스토어에 등록했습니다.');
      } catch {
        say('err', '스토어 등록에 실패했습니다.');
      }
    },
    [refreshStore, say],
  );

  const download = useCallback(
    async (item: StoreAvatar) => {
      setStoreBusy(item.storeId);
      try {
        const descriptor = await xgen.avatars.storeDownload(item.storeId);
        await run(
          () =>
            xgen.avatars.add(
              descriptor,
              dedupeName(
                descriptor.name,
                avatars.map((a) => a.name),
              ),
            ),
          '내 아바타에 추가했습니다.',
        );
        await refreshStore();
      } catch {
        say('err', '내려받기에 실패했습니다.');
      } finally {
        setStoreBusy(null);
      }
    },
    [avatars, refreshStore, run, say],
  );

  const unpublish = useCallback(
    async (item: StoreAvatar) => {
      setStoreBusy(item.storeId);
      try {
        await xgen.avatars.storeUnpublish(item.storeId);
        await refreshStore();
        say('ok', '스토어에서 내렸습니다.');
      } catch {
        say('err', '내리기에 실패했습니다.');
      } finally {
        setStoreBusy(null);
      }
    },
    [refreshStore, say],
  );

  const rate = useCallback(
    async (item: StoreAvatar, stars: number) => {
      setItems((prev) =>
        prev.map((i) => (i.storeId === item.storeId ? { ...i, myRating: stars } : i)),
      ); // optimistic
      try {
        const updated = await xgen.avatars.storeRate(item.storeId, stars);
        setItems((prev) => prev.map((i) => (i.storeId === item.storeId ? updated : i)));
      } catch {
        say('err', '별점 등록에 실패했습니다.');
        void refreshStore();
      }
    },
    [refreshStore, say],
  );

  const myUserId = Number(user.userId);

  return (
    <div className="avset">
      <div className="avset-header">
        <div className="avset-header-left">
          <button className="icon-btn" title="채팅으로 돌아가기" onClick={onBack}>
            <BackIcon size={17} />
          </button>
          <div>
            <strong>아바타 설정</strong>
            <div className="small muted">아바타를 등록·관리하고 오버레이에 표시합니다</div>
          </div>
        </div>
        <div className="seg">
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            설정
          </button>
          <button className={tab === 'store' ? 'active' : ''} onClick={() => setTab('store')}>
            스토어
          </button>
        </div>
      </div>

      {notice && <div className={`avset-notice ${notice.kind}`}>{notice.text}</div>}

      <div className="avset-body">
        {loadError ? (
          <div className="avset-card avset-empty">설정을 불러오지 못했습니다.</div>
        ) : !config ? (
          <div className="avset-card avset-empty">불러오는 중…</div>
        ) : tab === 'settings' ? (
          <>
            <div className="avset-card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <p className="avset-card-title">아바타 기능 사용</p>
                  <p className="small muted" style={{ margin: 0 }}>
                    켜면 아바타 오버레이(플로팅)에 선택한 아바타가 표시됩니다.
                  </p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    disabled={busy}
                    onChange={(e) => void run(() => xgen.avatars.setEnabled(e.target.checked))}
                  />
                  <span className="track" />
                </label>
              </div>
            </div>

            <div className="avset-card">
              <p className="avset-card-title">아바타 추가</p>
              <p className="small muted" style={{ margin: '0 0 12px' }}>
                Live2D/Spine 모델(zip) 또는 사진(png/jpg)을 업로드하세요. 사진은 간단히 크롭할 수
                있고, 추가 전에 미리보기로 정상 동작을 확인한 뒤 이름을 정합니다.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,.png,.jpg,.jpeg,.webp"
                hidden
                onChange={onFileChange}
              />
              <button
                className="primary"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                <UploadIcon size={15} />{' '}
                {uploading ? '업로드 중…' : '아바타 업로드 (모델 zip / 사진)'}
              </button>
            </div>

            {selected && (
              <div className="avset-card">
                <p className="avset-card-title">
                  미리보기 <span className="small muted">{selected.name}</span>
                </p>
                <p className="small muted" style={{ margin: '0 0 10px' }}>
                  휠로 확대/축소, 드래그로 위치를 맞추면 오버레이에도 그대로 적용됩니다.
                </p>
                <div className="avset-preview">
                  <AvatarModel
                    key={selected.id}
                    avatar={selected}
                    serverUrl={serverUrl}
                    onTransform={onTransform}
                  />
                </div>
              </div>
            )}

            <div className="avset-card">
              <p className="avset-card-title">내 아바타</p>
              {avatars.length === 0 ? (
                <p className="small muted" style={{ padding: '14px 0', margin: 0 }}>
                  등록된 아바타가 없습니다. 위에서 업로드하거나 스토어에서 내려받으세요.
                </p>
              ) : (
                avatars.map((a) => {
                  const isSelected = selected?.id === a.id;
                  return (
                    <div key={a.id} className={`avset-item ${isSelected ? 'selected' : ''}`}>
                      <button
                        className="avset-item-main"
                        onClick={() => onSelect(a.id)}
                        title="선택"
                      >
                        <span className={`avset-radio ${isSelected ? 'on' : ''}`}>
                          {isSelected && <span />}
                        </span>
                        {a.runtime === 'image' ? (
                          <img src={assetUrl(a.modelUrl)} alt={a.name} className="avset-thumb" />
                        ) : (
                          <span className="avset-thumb letter">
                            {(a.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="avset-item-name">
                          <span className="nm">{a.name}</span>
                          <span className="avset-badge">{runtimeLabel(a.runtime)}</span>
                          {isSelected && <span className="avset-badge ok">사용 중</span>}
                        </span>
                      </button>
                      <button
                        className="icon-btn"
                        title="이름 변경"
                        onClick={() => setRenaming(a)}
                        disabled={busy}
                      >
                        <PencilIcon size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title="삭제"
                        onClick={() => setConfirmDelete(a)}
                        disabled={busy}
                      >
                        <TrashIcon size={14} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : (
          <>
            <div className="avset-store-head">
              <div>
                <p className="avset-card-title">스토어</p>
                <p className="small muted" style={{ margin: 0 }}>
                  공유된 아바타를 내려받아 바로 사용할 수 있습니다.
                </p>
              </div>
              <button
                className="primary"
                onClick={() => setShowPublish(true)}
                disabled={avatars.length === 0}
              >
                등록
              </button>
            </div>
            {storeLoading ? (
              <div className="avset-card avset-empty">불러오는 중…</div>
            ) : items.length === 0 ? (
              <div className="avset-card avset-empty">아직 등록된 아바타가 없습니다.</div>
            ) : (
              <div className="avset-grid">
                {items.map((item) => {
                  const mine = Number.isFinite(myUserId) && item.publisherUserId === myUserId;
                  return (
                    <div key={item.storeId} className="avset-card avset-store-card">
                      <div className="avset-store-preview">
                        <StorePreview avatar={item.descriptor} serverUrl={serverUrl} />
                      </div>
                      <div className="avset-store-title">
                        <span className="nm">{item.name}</span>
                        <span className="avset-badge">{runtimeLabel(item.runtime)}</span>
                      </div>
                      <p className="avset-store-desc">{item.description || '—'}</p>
                      <div className="avset-store-meta">
                        <Stars value={item.ratingAvg} />
                        <span className="strong">
                          {item.ratingAvg ? item.ratingAvg.toFixed(1) : '—'}
                        </span>
                        <span>({item.ratingCount})</span>
                      </div>
                      <div className="avset-store-meta dim">
                        {item.publisherName ? `${item.publisherName} · ` : ''}
                        {item.downloads || 0}회 내려받음
                      </div>
                      <div className="avset-store-meta dim">
                        내 평점{' '}
                        <Stars
                          value={item.myRating ?? 0}
                          interactive
                          onRate={(s) => void rate(item, s)}
                        />
                      </div>
                      <div className="avset-store-actions">
                        <button
                          className="primary grow"
                          onClick={() => void download(item)}
                          disabled={storeBusy === item.storeId}
                        >
                          {storeBusy === item.storeId ? '…' : '내려받기'}
                        </button>
                        {mine && (
                          <button
                            className="secondary"
                            onClick={() => void unpublish(item)}
                            disabled={storeBusy === item.storeId}
                          >
                            내리기
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {cropFile && (
        <AvatarCropModal
          file={cropFile}
          onClose={() => setCropFile(null)}
          onCrop={(cropped) => {
            setCropFile(null);
            void doUpload(cropped);
          }}
        />
      )}

      {pendingAdd && (
        <AvatarNameModal
          avatar={pendingAdd}
          serverUrl={serverUrl}
          mode="add"
          existingNames={avatars.map((a) => a.name)}
          busy={busy}
          onConfirm={(name) => void confirmAdd(name)}
          onCancel={cancelAdd}
        />
      )}

      {renaming && (
        <AvatarNameModal
          avatar={renaming}
          serverUrl={serverUrl}
          mode="rename"
          existingNames={avatars.filter((a) => a.id !== renaming.id).map((a) => a.name)}
          busy={busy}
          onConfirm={(name) => void confirmRename(name)}
          onCancel={() => setRenaming(null)}
        />
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>아바타 삭제</h2>
              <button className="link" onClick={() => setConfirmDelete(null)}>
                닫기
              </button>
            </div>
            <p className="small" style={{ margin: '0 0 18px' }}>
              &lsquo;{confirmDelete.name}&rsquo; 아바타를 삭제할까요? 되돌릴 수 없습니다.
            </p>
            <div className="avset-modal-actions">
              <button className="secondary" onClick={() => setConfirmDelete(null)}>
                취소
              </button>
              <button className="danger" onClick={() => void doDelete(confirmDelete)}>
                삭제
              </button>
            </div>
          </div>
        </div>
      )}

      {showPublish && (
        <PublishModal
          myAvatars={avatars}
          onClose={() => setShowPublish(false)}
          onPublish={doPublish}
        />
      )}
    </div>
  );
};
