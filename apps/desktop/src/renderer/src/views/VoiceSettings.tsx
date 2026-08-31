/**
 * 음성 설정 — STT/TTS 상태(읽기 전용 힌트) + 이 기기에서의 사용 여부(로컬 토글).
 *
 * 실제 음성 서비스/목소리 구성은 XGEN 웹 마이페이지 → 설정에서 관리한다. 여기서는
 * 서버가 켜준 기능을 이 기기에서 쓸지만 조정한다(로컬 override 는 connector.json).
 * 비밀(base_url/api_key)은 서버에만 있으며 여기로 오지 않는다.
 */
import React, { useEffect, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';
import { xgen } from '../bridge';
import type { VoiceConfig } from '@dex/protocol';

export const VoiceSettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  // Esc 로도 닫힌다 (바깥 클릭은 backdrop 이 처리).
  useModalDismiss(onClose);
  const [cfg, setCfg] = useState<VoiceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState(true);
  const [output, setOutput] = useState(true);
  const [volume, setVolume] = useState(100);

  useEffect(() => {
    let alive = true;
    xgen.config
      .get()
      .then((c) => {
        if (!alive) return;
        setInput(c.voiceInput !== false);
        setOutput(c.voiceOutput !== false);
        setVolume(typeof c.voiceVolume === 'number' ? c.voiceVolume : 100);
      })
      .catch(() => undefined);
    xgen.voice
      .getConfig()
      .then((c) => alive && setCfg(c))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const setLocal = async (patch: { voiceInput?: boolean; voiceOutput?: boolean }) => {
    if (patch.voiceInput !== undefined) setInput(patch.voiceInput);
    if (patch.voiceOutput !== undefined) setOutput(patch.voiceOutput);
    await xgen.config.set(patch);
  };

  const stt = cfg?.stt ?? null;
  const tts = cfg?.tts ?? null;
  const activeProfile = tts?.profiles?.find((p) => p.id === tts.active_profile_id) ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>음성 설정</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>

        <p className="small muted">
          음성 서비스와 목소리는 XGEN 웹 마이페이지 → 설정에서 관리합니다. 여기서는 이
          기기에서의 사용 여부만 조정합니다.
        </p>

        {loading ? (
          <p className="small muted">불러오는 중…</p>
        ) : err ? (
          <p className="small notice-warn">{err}</p>
        ) : (
          <>
            <div className="field-row">
              <span>
                음성 입력 (STT)
                <span className="small muted" style={{ marginLeft: 8 }}>
                  {stt?.enabled ? '서버 활성' : '서버 비활성'}
                </span>
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  disabled={!stt?.enabled}
                  checked={input && !!stt?.enabled}
                  onChange={(e) => void setLocal({ voiceInput: e.target.checked })}
                />
                <span className="track" />
              </label>
            </div>
            {stt?.enabled && (
              <div className="small muted" style={{ marginBottom: 8 }}>
                서비스: {stt.provider || '—'}
                {stt.model_id ? ` · ${stt.model_id}` : ''}
                {stt.language ? ` · ${stt.language}` : ' · 자동 언어'}
              </div>
            )}

            <div className="field-row">
              <span>
                음성 출력 (TTS)
                <span className="small muted" style={{ marginLeft: 8 }}>
                  {tts?.enabled ? '서버 활성' : '서버 비활성'}
                </span>
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  disabled={!tts?.enabled}
                  checked={output && !!tts?.enabled}
                  onChange={(e) => void setLocal({ voiceOutput: e.target.checked })}
                />
                <span className="track" />
              </label>
            </div>
            {tts?.enabled && (
              <div className="field-row">
                <span>
                  재생 볼륨
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    {volume}%{volume > 100 ? ' (부스트)' : ''}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={300}
                  step={5}
                  value={volume}
                  style={{ width: 180, accentColor: 'var(--primary-end)' }}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    void xgen.config.set({ voiceVolume: v });
                  }}
                />
              </div>
            )}
            {tts?.enabled && (
              <div className="small muted" style={{ marginBottom: 8 }}>
                목소리:{' '}
                {activeProfile
                  ? `${activeProfile.name} (${activeProfile.voice_id})`
                  : '선택된 프로필 없음'}
                {activeProfile?.language ? ` · ${activeProfile.language}` : ''}
              </div>
            )}

            {!stt?.enabled && !tts?.enabled && (
              <p className="small muted">
                음성 기능이 아직 활성화되지 않았습니다. 관리자 설정 또는 마이페이지에서
                활성화하세요.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
