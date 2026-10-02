/**
 * FileViewerPane — 파일 하나를 **그려서** 보여 주는 뷰어. 탐색기 탭·에이전트 [스토리지]·IDE 미리보기가 함께 쓴다.
 *
 * 코드/텍스트는 VS Code 풍(줄 번호 + 구문 강조 + 줄바꿈 토글)으로, 문서류는
 * 웹 [파일 저장소]와 같은 렌더(이미지/PDF/오디오/비디오 네이티브, 오피스는
 * 서버 렌더 페이지 이미지)로 보여준다. 읽기 전용 — 편집은 하지 않는다.
 *
 * 어디서 읽는지는 출처(FileViewerSource)가 정한다 — 그리는 규칙은 하나다:
 *   · 파일 저장소 → storage.cloudReadRaw · 문서는 filestore-preview
 *   · 에이전트    → agentData.workspaceBinary · 문서는 geny-workspace doc-preview (같은 렌더러)
 *   · IDE         → IDE 가 고른 길(샌드박스·연결된 폴더) · 문서는 작업 공간 doc-preview
 *
 * 예전에는 문서(docx·pptx·xlsx·hwp)를 [파일 저장소] 출처에서만 그렸다 — 에이전트가 만든 보고서는 "다운로드해
 * 여세요" 로 끝났다(2026-10-02 사용자 보고). 서버는 작업 공간 문서도 같은 렌더러로 그려 준다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import { xgen, copyText } from '../bridge';
import { Markdown } from './Markdown';
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

/** 문서(docx·pptx·xlsx·hwp)의 서버 렌더 페이지. */
export interface OfficePagesSource {
  /** 페이지 열쇠 목록 — 처음 여는 문서는 서버가 그리는 동안 오래 걸린다. 그릴 수 없으면 던진다. */
  pages(): Promise<string[]>;
  page(page: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

/** 이 파일을 어디서 읽는가. */
export interface FileViewerSource {
  /** 머리에 보이는 출처 이름. */
  label: string;
  readRaw(): Promise<Uint8Array>;
  /** 없으면 문서는 그리지 못하고 내려받기 안내로 간다. */
  office?: OfficePagesSource;
}

/** [파일 저장소] 의 파일. */
export function cloudFileSource(rel: string): FileViewerSource {
  let itemId: number | null = null;
  return {
    label: '파일 저장소',
    async readRaw() {
      const r = await xgen.storage.cloudReadRaw(rel);
      if (!r.ok || !r.bytes) throw new Error(r.error || '다운로드 실패');
      return r.bytes;
    },
    office: {
      async pages() {
        const meta = await xgen.storage.cloudOfficePreview(rel);
        if (!meta.ok || meta.itemId == null || !meta.pages?.length) {
          throw new Error(meta.error || '이 문서의 미리보기를 만들지 못했습니다.');
        }
        itemId = meta.itemId;
        return meta.pages;
      },
      async page(page: string) {
        if (itemId == null) throw new Error('문서 미리보기를 먼저 불러와야 합니다.');
        const r = await xgen.storage.cloudOfficePreviewPage(itemId, page);
        if (!r.ok || !r.bytes) throw new Error(r.error || '페이지를 받지 못했습니다.');
        return { bytes: r.bytes, contentType: r.contentType ?? '' };
      },
    },
  };
}

/** 에이전트 작업 공간의 문서 렌더 — [파일 저장소] 와 같은 렌더러(서버). `rel` 은 workspace 기준 경로. */
export function workspaceOfficePages(workflowId: string, rel: string): OfficePagesSource {
  return {
    async pages() {
      const meta = await xgen.agentData.workspaceDocPreview(workflowId, rel);
      if (meta.kind === 'unsupported' || !meta.pages.length) throw new Error('이 문서의 미리보기를 만들지 못했습니다.');
      return meta.pages;
    },
    page: (page: string) => xgen.agentData.workspacePreviewPage(workflowId, page),
  };
}

/** 에이전트 작업 공간(서버 스토리지)의 파일. */
export function agentFileSource(workflowId: string, rel: string): FileViewerSource {
  return {
    label: '에이전트 워크스페이스',
    readRaw: async () => (await xgen.agentData.workspaceBinary(workflowId, rel)).bytes,
    office: workspaceOfficePages(workflowId, rel),
  };
}

export interface FileViewerProps {
  fileName: string;
  /** 탐색기 탭 — 출처를 구역으로 준다(source 를 주면 쓰지 않는다). */
  sectionKind?: 'cloud' | 'agent';
  workflowId?: string;
  rel?: string;
  /** 출처를 직접 준다(에이전트 [스토리지]·IDE). */
  source?: FileViewerSource;
  /** 출처가 바뀌었는지 가르는 열쇠(파일이 바뀌면 달라져야 다시 읽는다). */
  sourceKey?: string;
  /** 편집 중인 글(IDE 의 md·csv) — 주면 바이트 대신 이것을 그린다. */
  text?: string;
  /** IDE 안 — 탭이 이름을 보여 주므로 머리에서 이름과 [원본] 전환을 뺀다. */
  embedded?: boolean;
  /** 내려받기를 맡긴다(없으면 읽은 바이트로 저장). */
  onDownload?: () => void;
}

interface Loaded {
  bytes: Uint8Array;
}

/** IPC 로 온 Uint8Array 는 더 큰 버퍼 위 뷰일 수 있다 — 정확한 조각으로 Blob 을 만든다. */
function toBlob(bytes: Uint8Array, type: string): Blob {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Blob([buffer as ArrayBuffer], { type });
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
      {truncated && <div className="fv-note">표시는 2,000행까지입니다. 전체는 [원본]이나 다운로드로 보세요.</div>}
    </div>
  );
};

// ── 오피스 문서 (서버 렌더 페이지) ───────────────────────────────

const OfficeView: React.FC<{ office: OfficePagesSource; sourceKey: string; fileName: string }> = ({
  office,
  sourceKey,
  fileName,
}) => {
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
        const pages = await office.pages();
        if (cancelled) return;
        const urls: string[] = [];
        for (const page of pages) {
          const res = await office.page(page).catch(() => null);
          if (cancelled) return;
          if (res?.bytes?.byteLength) {
            // 서버의 형식 표시가 없거나 뭉뚱그려 오면(octet-stream) 확장자로 — SVG 페이지가 그림으로 안 뜨던 자리다.
            const declared = (res.contentType || '').split(';')[0].trim();
            const type = declared.startsWith('image/') ? declared : page.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  if (state === 'loading' && pageUrls.length === 0) {
    return <div className="fv-note">문서를 렌더링하는 중… (처음 열 때는 수십 초 걸릴 수 있습니다)</div>;
  }
  if (state === 'error') return <div className="fv-note error">{error}</div>;
  return (
    <div className="fv-office">
      {pageUrls.map((u, i) => (
        <img key={i} src={u} alt={`${fileName} ${i + 1}페이지`} className="fv-office-page" />
      ))}
      {state === 'loading' && <div className="fv-note">다음 페이지 불러오는 중…</div>}
    </div>
  );
};

// ── 본체 ────────────────────────────────────────────────────────

export const FileViewerPane: React.FC<FileViewerProps> = ({
  sectionKind = 'agent',
  workflowId = '',
  rel = '',
  fileName,
  source: givenSource,
  sourceKey: givenKey,
  text: givenText,
  embedded = false,
  onDownload,
}) => {
  const sourceKey = givenKey ?? `${sectionKind}:${workflowId}:${rel}`;
  // 출처는 열쇠가 같으면 그대로 둔다 — 매 그리기마다 새로 만들면 다시 읽기를 되풀이한다.
  const source = useMemo<FileViewerSource>(
    () => givenSource ?? (sectionKind === 'cloud' ? cloudFileSource(rel) : agentFileSource(workflowId, rel)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceKey],
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawMode, setRawMode] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [blobUrl, setBlobUrl] = useState('');
  const loadSeq = useRef(0);

  const declared: ViewerKind = kindForFile(fileName);
  // 문서 렌더가 없는 출처(이 PC 의 연결된 폴더)만 안내 패널로 — 서버는 파일 저장소·작업 공간 문서를 같은 렌더러로 그린다.
  const kind: ViewerKind = declared === 'office' && !source.office ? 'binary' : declared;
  // 편집 중인 글을 그리는 경우(IDE 의 md·csv) — 바이트를 읽지 않는다.
  const liveText = givenText !== undefined && ['markdown', 'csv', 'code'].includes(kind) ? givenText : undefined;

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadErr(null);
    setLoaded(null);
    try {
      // 오피스는 바이트가 필요 없다 (서버 렌더) — 편집 중인 글을 그릴 때도. 로드를 건너뛴다.
      if (kind === 'office' || liveText !== undefined) {
        if (seq === loadSeq.current) setLoading(false);
        return;
      }
      const bytes = await source.readRaw();
      if (seq !== loadSeq.current) return;
      setLoaded({ bytes });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, kind, liveText !== undefined]);

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
    if (liveText !== undefined) return liveText;
    if (!loaded) return '';
    if (!['code', 'markdown', 'csv', 'binary'].includes(kind)) return '';
    if (kind === 'binary' && looksBinary(loaded.bytes)) return '';
    const t = decodeText(
      loaded.bytes.byteLength > TEXT_RENDER_LIMIT
        ? loaded.bytes.subarray(0, TEXT_RENDER_LIMIT)
        : loaded.bytes,
    );
    return t;
  }, [loaded, kind, liveText]);
  // 글로 보여 주는 형식만 앞부분을 자른다 — PDF·그림 같은 파일에 "앞 2MB만 표시"가 붙으면 안 된다
  const textTruncated =
    !!loaded && ['code', 'markdown', 'csv', 'binary'].includes(kind) && loaded.bytes.byteLength > TEXT_RENDER_LIMIT;
  // 미지의 확장자가 텍스트면 code 로 승격.
  const effKind: ViewerKind = kind === 'binary' && text ? 'code' : kind;

  const download = useCallback(() => {
    if (onDownload) {
      onDownload();
      return;
    }
    if (!loaded) return;
    const url = URL.createObjectURL(toBlob(loaded.bytes, 'application/octet-stream'));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, [loaded, fileName, onDownload]);

  const sizeLabel = loaded ? formatBytes(loaded.bytes.byteLength) : '';
  const sourceLabel = source.label;
  const canDownload = !!onDownload || !!loaded;

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
  } else if (effKind === 'office' && source.office)
    body = <OfficeView office={source.office} sourceKey={sourceKey} fileName={fileName} />;
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
            ? '이 PC 폴더의 문서는 미리보기를 만들 수 없습니다. 내려받아 여세요.'
            : '미리보기를 지원하지 않는 형식입니다.'}
        </div>
        <div className="fv-binary-actions">
          <button className="viewer-btn" onClick={download} disabled={!canDownload}>
            다운로드
          </button>
        </div>
      </div>
    );

  const showsText = ['code', 'markdown', 'csv'].includes(effKind);
  return (
    <div className={`fv-root${embedded ? ' embedded' : ''}`}>
      <div className="fv-head">
        {!embedded && (
          <span className="fv-title" title={rel || fileName}>
            {fileName}
          </span>
        )}
        <span className="fv-meta">
          {sizeLabel}
          {sourceLabel ? ` · ${sourceLabel}` : ''}
          {textTruncated ? ' · 앞 2MB만 표시' : ''}
        </span>
        <span className="fv-actions">
          {!embedded && (effKind === 'markdown' || effKind === 'csv') && (
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
          <button className="viewer-btn sm" onClick={download} disabled={!canDownload}>
            다운로드
          </button>
          <button className="viewer-btn sm" onClick={() => void load()} title="다시 읽기">
            <RefreshIcon size={12} />
          </button>
        </span>
      </div>
      <div className="fv-body">{body}</div>
    </div>
  );
};
