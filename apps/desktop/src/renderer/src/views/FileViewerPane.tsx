/**
 * FileViewerPane — 탐색기에서 파일을 클릭하면 콘텐츠 영역에 열리는 뷰어 탭.
 *
 * 코드/텍스트는 VS Code 풍(줄 번호 + 구문 강조 + 줄바꿈 토글)으로, 문서류는
 * 웹 [파일 저장소]와 같은 렌더(이미지/PDF/오디오/비디오 네이티브, 오피스는
 * 서버 렌더 페이지 이미지)로 보여준다. 읽기 전용 — 편집은 하지 않는다.
 *
 * 데이터 경로 (탐색기와 동일한 이원화):
 *   · 동기화 ON  → fileSystem.readFile (로컬 실파일)
 *   · 클라우드 OFF → fileSystem.cloudReadRaw (파일 저장소 /sync/raw)
 *   · 에이전트 OFF → agentData.workspaceBinary (서버 워크스페이스)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import { xgen, copyText } from '../bridge';
import { Markdown } from './Markdown';
import type { FileSystemStatusLike } from '../../../preload/index';
import {
  decodeText,
  escapeHtml,
  extOf,
  formatBytes,
  HIGHLIGHT_LIMIT,
  kindForFile,
  langForFile,
  looksBinary,
  mimeForFile,
  parseCsv,
  splitHighlightedLines,
  TEXT_RENDER_LIMIT,
  type ViewerKind,
} from './file-viewer-model';
import { CopyIcon, DocIcon, RefreshIcon } from '../brand/icons';

// ── highlight.js 언어 등록 (일회) ────────────────────────────────
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import less from 'highlight.js/lib/languages/less';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import powershell from 'highlight.js/lib/languages/powershell';
import yaml from 'highlight.js/lib/languages/yaml';
import ini from 'highlight.js/lib/languages/ini';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import swift from 'highlight.js/lib/languages/swift';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import lua from 'highlight.js/lib/languages/lua';
import perl from 'highlight.js/lib/languages/perl';
import r from 'highlight.js/lib/languages/r';
import dart from 'highlight.js/lib/languages/dart';
import scala from 'highlight.js/lib/languages/scala';
import groovy from 'highlight.js/lib/languages/groovy';
import gradle from 'highlight.js/lib/languages/gradle';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import makefile from 'highlight.js/lib/languages/makefile';
import cmake from 'highlight.js/lib/languages/cmake';
import diff from 'highlight.js/lib/languages/diff';
import graphql from 'highlight.js/lib/languages/graphql';
import protobuf from 'highlight.js/lib/languages/protobuf';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';

const LANGS: Record<string, unknown> = {
  javascript, typescript, python, json, xml, css, scss, less, bash, shell, powershell,
  yaml, ini, sql, java, kotlin, c, cpp, csharp, go, rust, swift, ruby, php, lua, perl,
  r, dart, scala, groovy, gradle, dockerfile, makefile, cmake, diff, graphql, protobuf,
  markdown, plaintext,
};
for (const [name, def] of Object.entries(LANGS)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, def as Parameters<typeof hljs.registerLanguage>[1]);
}

export interface FileViewerProps {
  sectionKind: 'cloud' | 'agent';
  workflowId: string;
  rel: string;
  fileName: string;
}

interface Loaded {
  bytes: Uint8Array;
  source: 'local' | 'cloud' | 'agent';
}

/** IPC 로 온 Uint8Array 는 더 큰 버퍼 위 뷰일 수 있다 — 정확한 조각으로 Blob 을 만든다. */
function toBlob(bytes: Uint8Array, type: string): Blob {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Blob([buffer as ArrayBuffer], { type });
}

function isSynced(status: FileSystemStatusLike | null, workflowId: string): boolean {
  if (!status) return false;
  if (status.cloud.owner === workflowId) return status.cloud.enabled && status.cloud.synced;
  return status.agents.list.some((a) => a.workflowId === workflowId && a.synced);
}

// ── 코드 뷰 (줄 번호 + 구문 강조) ────────────────────────────────

const CodeView: React.FC<{ text: string; lang: string; wrap: boolean }> = ({ text, lang, wrap }) => {
  const lines = useMemo(() => {
    const tooBig = text.length > HIGHLIGHT_LIMIT;
    if (tooBig || lang === 'plaintext' || !hljs.getLanguage(lang)) {
      return text.split('\n').map(escapeHtml);
    }
    try {
      return splitHighlightedLines(hljs.highlight(text, { language: lang }).value);
    } catch {
      return text.split('\n').map(escapeHtml);
    }
  }, [text, lang]);
  const width = `${String(lines.length).length}ch`;
  return (
    <div className={`fv-code ${wrap ? 'wrap' : ''}`}>
      {lines.map((html, i) => (
        <div className="fv-line" key={i}>
          <span className="fv-ln" style={{ minWidth: width }}>
            {i + 1}
          </span>
          {/* 강조 HTML 은 hljs 가 이스케이프한 산출물 그대로다 — 원문 주입 없음 */}
          <span className="fv-lc" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
        </div>
      ))}
    </div>
  );
};

// ── CSV 표 뷰 ───────────────────────────────────────────────────

const CsvView: React.FC<{ text: string; delim: ',' | '\t' }> = ({ text, delim }) => {
  const { rows, truncated } = useMemo(() => parseCsv(text, delim), [text, delim]);
  if (rows.length === 0) return <div className="fv-note">빈 파일입니다.</div>;
  const [head, ...body] = rows;
  return (
    <div className="fv-csv-scroll">
      <table className="fv-csv">
        <thead>
          <tr>
            <th className="fv-csv-ln" />
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              <td className="fv-csv-ln">{i + 1}</td>
              {head.map((_, j) => (
                <td key={j}>{r[j] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <div className="fv-note">표시는 2,000행까지 — 전체는 [원본]이나 다운로드로.</div>}
    </div>
  );
};

// ── 오피스 문서 (서버 렌더 페이지) ───────────────────────────────

const OfficeView: React.FC<{ rel: string; fileName: string }> = ({ rel, fileName }) => {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [pageUrls, setPageUrls] = useState<string[]>([]);
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setPageUrls([]);
    void (async () => {
      try {
        const meta = await xgen.fileSystem.cloudOfficePreview(rel);
        if (cancelled) return;
        if (!meta.ok || meta.itemId == null || !meta.pages?.length) {
          setError(meta.error || '이 문서의 미리보기를 만들지 못했습니다.');
          setState('error');
          return;
        }
        const urls: string[] = [];
        for (const page of meta.pages) {
          const res = await xgen.fileSystem.cloudOfficePreviewPage(meta.itemId, page);
          if (cancelled) return;
          if (res.ok && res.bytes) {
            const type =
              res.contentType || (page.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
            urls.push(URL.createObjectURL(toBlob(res.bytes, type)));
            urlsRef.current = urls;
            setPageUrls([...urls]);
            setState('ready');
          }
        }
        if (urls.length === 0) {
          setError('페이지 이미지를 받지 못했습니다.');
          setState('error');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const u of urlsRef.current) URL.revokeObjectURL(u);
      urlsRef.current = [];
    };
  }, [rel]);

  if (state === 'loading' && pageUrls.length === 0) {
    return <div className="fv-note">문서를 렌더링하는 중… (처음 열 때는 수십 초 걸릴 수 있습니다)</div>;
  }
  if (state === 'error') return <div className="fv-note error">{error}</div>;
  return (
    <div className="fv-office">
      {pageUrls.map((u, i) => (
        <img key={i} src={u} alt={`${fileName} — ${i + 1}페이지`} className="fv-office-page" />
      ))}
      {state === 'loading' && <div className="fv-note">다음 페이지 불러오는 중…</div>}
    </div>
  );
};

// ── 본체 ────────────────────────────────────────────────────────

export const FileViewerPane: React.FC<FileViewerProps> = ({
  sectionKind,
  workflowId,
  rel,
  fileName,
}) => {
  const [status, setStatus] = useState<FileSystemStatusLike | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawMode, setRawMode] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [blobUrl, setBlobUrl] = useState('');
  const loadSeq = useRef(0);

  useEffect(() => {
    void xgen.fileSystem
      .status()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  const declared: ViewerKind = kindForFile(fileName);
  // 오피스 렌더는 파일 저장소 항목에만 있다 — 에이전트 워크스페이스는 정보 패널로.
  const kind: ViewerKind = declared === 'office' && sectionKind !== 'cloud' ? 'binary' : declared;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadErr(null);
    setLoaded(null);
    try {
      // 오피스는 바이트가 필요 없다 (서버 렌더) — 로드를 건너뛴다.
      if (kind === 'office') {
        if (seq === loadSeq.current) setLoading(false);
        return;
      }
      const st = status ?? (await xgen.fileSystem.status().catch(() => null));
      let result: Loaded;
      if (isSynced(st, workflowId)) {
        const r = await xgen.fileSystem.readFile(workflowId, rel);
        if (!r.ok || !r.bytes) throw new Error(r.error || '읽기 실패');
        result = { bytes: r.bytes, source: 'local' };
      } else if (sectionKind === 'cloud') {
        const r = await xgen.fileSystem.cloudReadRaw(rel);
        if (!r.ok || !r.bytes) throw new Error(r.error || '다운로드 실패');
        result = { bytes: r.bytes, source: 'cloud' };
      } else {
        const r = await xgen.agentData.workspaceBinary(workflowId, rel);
        result = { bytes: r.bytes, source: 'agent' };
      }
      if (seq !== loadSeq.current) return;
      setLoaded(result);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, rel, sectionKind, kind]);

  useEffect(() => {
    void load();
    return () => {
      loadSeq.current += 1;
    };
  }, [load]);

  // 미디어류 Blob URL 수명.
  useEffect(() => {
    if (!loaded) return;
    if (!['image', 'pdf', 'audio', 'video'].includes(kind)) return;
    const url = URL.createObjectURL(toBlob(loaded.bytes, mimeForFile(fileName)));
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setBlobUrl('');
    };
  }, [loaded, kind, fileName]);

  const text = useMemo(() => {
    if (!loaded) return '';
    if (!['code', 'markdown', 'csv', 'binary'].includes(kind)) return '';
    if (kind === 'binary' && looksBinary(loaded.bytes)) return '';
    const t = decodeText(
      loaded.bytes.byteLength > TEXT_RENDER_LIMIT
        ? loaded.bytes.subarray(0, TEXT_RENDER_LIMIT)
        : loaded.bytes,
    );
    return t;
  }, [loaded, kind]);
  const textTruncated = !!loaded && loaded.bytes.byteLength > TEXT_RENDER_LIMIT;
  // 미지의 확장자가 텍스트면 code 로 승격.
  const effKind: ViewerKind = kind === 'binary' && text ? 'code' : kind;

  const download = useCallback(() => {
    if (!loaded) return;
    const url = URL.createObjectURL(toBlob(loaded.bytes, 'application/octet-stream'));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [loaded, fileName]);

  const synced = isSynced(status, workflowId);
  const sizeLabel = loaded ? formatBytes(loaded.bytes.byteLength) : '';
  const sourceLabel =
    loaded?.source === 'local' ? '로컬 동기화본' : loaded?.source === 'cloud' ? '파일 저장소' : loaded?.source === 'agent' ? '에이전트 워크스페이스' : '';

  let body: React.ReactNode = null;
  if (loading) body = <div className="fv-note">불러오는 중…</div>;
  else if (loadErr) {
    body = (
      <div className="fv-note error">
        {loadErr}
        <div style={{ marginTop: 8 }}>
          <button className="viewer-btn sm" onClick={() => void load()}>
            <RefreshIcon size={12} /> 다시 시도
          </button>
        </div>
      </div>
    );
  } else if (effKind === 'office') body = <OfficeView rel={rel} fileName={fileName} />;
  else if (effKind === 'image')
    body = (
      <div className="fv-media">
        {blobUrl && <img src={blobUrl} alt={fileName} className="fv-image" />}
      </div>
    );
  else if (effKind === 'pdf')
    body = blobUrl ? (
      // Electron(Chromium) 내장 PDF 뷰어 — 웹 파일 저장소와 같은 경험.
      <iframe src={blobUrl} title={fileName} className="fv-pdf" />
    ) : null;
  else if (effKind === 'audio')
    body = (
      <div className="fv-media">{blobUrl && <audio src={blobUrl} controls className="fv-audio" />}</div>
    );
  else if (effKind === 'video')
    body = (
      <div className="fv-media">{blobUrl && <video src={blobUrl} controls className="fv-video" />}</div>
    );
  else if (effKind === 'markdown')
    body = rawMode ? (
      <CodeView text={text} lang="markdown" wrap={wrap} />
    ) : (
      <div className="fv-md">
        <Markdown text={text} />
      </div>
    );
  else if (effKind === 'csv')
    body = rawMode ? (
      <CodeView text={text} lang="plaintext" wrap={wrap} />
    ) : (
      <CsvView text={text} delim={extOf(fileName) === 'tsv' ? '\t' : ','} />
    );
  else if (effKind === 'code') body = <CodeView text={text} lang={langForFile(fileName)} wrap={wrap} />;
  else
    body = (
      <div className="fv-binary">
        <DocIcon size={40} />
        <div className="fv-binary-name">{fileName}</div>
        <div className="fv-note">
          {declared === 'office'
            ? '문서 미리보기는 [파일 저장소] 파일에서 지원됩니다 — 원본을 다운로드해 여세요.'
            : '미리보기를 지원하지 않는 형식입니다.'}
        </div>
        <div className="fv-binary-actions">
          <button className="viewer-btn" onClick={download} disabled={!loaded}>
            다운로드
          </button>
          {synced && (
            <button
              className="viewer-btn"
              onClick={() => void xgen.fileSystem.openPath(workflowId, rel)}
            >
              OS로 열기
            </button>
          )}
        </div>
      </div>
    );

  const showsText = ['code', 'markdown', 'csv'].includes(effKind);
  return (
    <div className="fv-root">
      <div className="fv-head">
        <span className="fv-title" title={rel}>
          {fileName}
        </span>
        <span className="fv-meta">
          {sizeLabel}
          {sourceLabel ? ` · ${sourceLabel}` : ''}
          {textTruncated ? ' · 앞 2MB만 표시' : ''}
        </span>
        <span className="fv-actions">
          {(effKind === 'markdown' || effKind === 'csv') && (
            <button
              className={`viewer-btn sm ${rawMode ? 'on' : ''}`}
              onClick={() => setRawMode((v) => !v)}
            >
              {rawMode ? '렌더' : '원본'}
            </button>
          )}
          {showsText && (rawMode || effKind === 'code') && (
            <button className={`viewer-btn sm ${wrap ? 'on' : ''}`} onClick={() => setWrap((v) => !v)}>
              줄바꿈
            </button>
          )}
          {showsText && (
            <button className="viewer-btn sm" onClick={() => void copyText(text)}>
              <CopyIcon size={12} /> 복사
            </button>
          )}
          <button className="viewer-btn sm" onClick={download} disabled={!loaded}>
            다운로드
          </button>
          {synced && (
            <button
              className="viewer-btn sm"
              onClick={() => void xgen.fileSystem.openPath(workflowId, rel)}
              title="OS 기본 앱으로 열기"
            >
              OS로 열기
            </button>
          )}
          <button className="viewer-btn sm" onClick={() => void load()} title="다시 읽기">
            <RefreshIcon size={12} />
          </button>
        </span>
      </div>
      <div className="fv-body">{body}</div>
    </div>
  );
};
