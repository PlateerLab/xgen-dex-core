/**
 * 대화의 파일 — 질문에 붙인 파일, 답이 작업 공간에 만든 파일, 답에 딸린 파일 저장소 결과물.
 *
 * 예전에는 첨부가 누를 수 없는 이름표뿐이었고, 답이 만든 파일·그림은 아예 보이지 않았다(웹과 데스크톱은
 * 그림 카드와 받기 단추가 있었다). 고르는 규칙은 웹·데스크톱과 같은 한 곳(@dex/protocol turn-files·
 * chat-files)이고, 그리는 것만 폰에 맞춘다:
 *   그림   답 아래에 바로 보인다. 누르면 크게 본다.
 *   파일   카드. 누르면 폰 안에서 연다(파일 보기 — 문서·PDF·표·코드를 그린다, [내보내기] 로 기기 앱에).
 * 요청한 결과물이 아닌 중간 파일은 "그 외 N개" 로 접어 둔다 — 전부 늘어놓으면 받을 파일을 못 찾는다.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  answerTurnFiles,
  chatDownloadRequest,
  formatFileSize,
  isChatImageName,
  sharedTreeFetch,
  shouldLookForTurnFiles,
  splitRequestedFiles,
  withoutShownFiles,
  type ChatDownload,
  type WsNode,
} from '@dex/protocol';
import { alpha, useP } from '../theme';
import type { XgenMobileClient } from '../lib/xgen';
import { serverLink } from '../lib/links';
import type { PreviewFile } from '../files/file-preview';
import type { ChatAttachmentMark, ChatMessage } from './message-model';

/**
 * 작업 공간 목록 — 대화를 열 때 답마다 묻던 것을 동시 요청 하나로 묶는다. 계정(클라이언트)마다 따로 둔다.
 */
const treeFetchers = new WeakMap<XgenMobileClient, (workflowId: string) => Promise<{ files?: WsNode[] }>>();
function workspaceTree(client: XgenMobileClient, workflowId: string): Promise<{ files?: WsNode[] }> {
  let fetcher = treeFetchers.get(client);
  if (!fetcher) {
    fetcher = sharedTreeFetch((wf: string) => client.api.agentData.workspaceTree(wf));
    treeFetchers.set(client, fetcher);
  }
  return fetcher(workflowId);
}

/** 답 아래에 바로 그릴 그림의 크기 상한 — 이보다 크면 카드로만 둔다(대화가 무거워지지 않게). */
const IMAGE_INLINE_MAX_BYTES = 12 * 1024 * 1024;

type Source = { uri: string; headers: Record<string, string> };

function workspaceSource(client: XgenMobileClient, workflowId: string, path: string, purpose?: 'chat_attachment'): Source | null {
  const uri = serverLink(client.session.serverUrl, client.api.agentData.workspaceRawPath(workflowId, path, purpose));
  return uri ? { uri, headers: { Authorization: `Bearer ${client.session.accessToken}` } } : null;
}

function downloadSource(client: XgenMobileClient, item: ChatDownload): Source | null {
  const req = chatDownloadRequest(item, { preview: !item.artifactId });
  const uri = req ? serverLink(client.session.serverUrl, req.path) : '';
  return uri && req ? { uri, headers: { Authorization: `Bearer ${client.session.accessToken}`, ...req.headers } } : null;
}

/** 그림 한 장 — 폭에 맞추고 비율은 받은 그림으로. 못 받으면 카드로 물러선다. */
const InlineImage: React.FC<{
  source: Source;
  name: string;
  size?: number | null;
  onPress: () => void;
  fallback: React.ReactNode;
}> = ({ source, name, size, onPress, fallback }) => {
  const p = useP();
  const { width } = useWindowDimensions();
  const box = Math.min(width - 48, 320);
  const [ratio, setRatio] = useState(1);
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={`${name} 크게 보기`}
      style={{ width: box, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: p.border, backgroundColor: p.panel }}
    >
      <Image
        source={source}
        style={{ width: box, height: Math.min(box / ratio, box * 1.4), backgroundColor: p.panel2 }}
        resizeMode="contain"
        onLoad={(e) => {
          const src = e.nativeEvent?.source;
          if (src?.width && src?.height) setRatio(src.width / src.height);
        }}
        onError={() => setFailed(true)}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 7 }}>
        <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontSize: 12 }}>
          {name}
        </Text>
        {size ? <Text style={{ color: p.muted, fontSize: 11 }}>{formatFileSize(size)}</Text> : null}
        <Ionicons name="expand-outline" size={15} color={p.muted} />
      </View>
    </Pressable>
  );
};

/** 파일 카드 — 형식 이름표·이름·크기. 누르면 폰 안에서 연다. */
const FileCard: React.FC<{ name: string; size?: number | null; minor?: boolean; onPress: () => void }> = ({
  name,
  size,
  minor,
  onPress,
}) => {
  const p = useP();
  const dot = name.lastIndexOf('.');
  const badge = (dot > 0 ? name.slice(dot + 1) : 'FILE').toUpperCase().slice(0, 4);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name} 열기`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        maxWidth: '100%',
        paddingHorizontal: 10,
        paddingVertical: minor ? 7 : 9,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: p.border,
        backgroundColor: pressed ? p.panel2 : p.panel,
        opacity: minor ? 0.85 : 1,
      })}
    >
      <View
        style={{
          minWidth: 38,
          height: 26,
          paddingHorizontal: 4,
          borderRadius: 6,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: alpha(p.primary, 14),
        }}
      >
        <Text style={{ color: p.primary, fontSize: 10, fontWeight: '800' }}>{badge}</Text>
      </View>
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ color: p.text, fontSize: 13, fontWeight: '600' }}>
          {name}
        </Text>
        {size ? <Text style={{ color: p.muted, fontSize: 11 }}>{formatFileSize(size)}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={15} color={p.muted} />
    </Pressable>
  );
};

/** 질문에 붙인 파일 — 말풍선 안. 작업 공간에 올라간 것은 그림은 작게 보이고, 누르면 연다. */
export const AttachmentChips: React.FC<{
  client: XgenMobileClient;
  workflowId: string;
  files: readonly ChatAttachmentMark[];
  onOpen: (file: PreviewFile) => void;
}> = ({ client, workflowId, files, onOpen }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 6 }}>
    {files.map((file, i) => {
      const open = file.workspacePath
        ? () => onOpen({ name: file.name, path: file.workspacePath, size: file.size, purpose: 'chat_attachment' })
        : undefined;
      const thumb =
        file.kind === 'image' && file.workspacePath
          ? workspaceSource(client, workflowId, file.workspacePath, 'chat_attachment')
          : null;
      if (thumb) {
        return (
          <Pressable key={`${file.name}-${i}`} onPress={open} accessibilityRole="imagebutton" accessibilityLabel={`${file.name} 크게 보기`}>
            <Image source={thumb} style={{ width: 120, height: 120, borderRadius: 10, backgroundColor: alpha('#FFFFFF', 18) }} />
          </Pressable>
        );
      }
      return (
        <Pressable
          key={`${file.name}-${i}`}
          onPress={open}
          disabled={!open}
          accessibilityRole="button"
          accessibilityLabel={open ? `${file.name} 열기` : file.name}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            backgroundColor: alpha('#FFFFFF', 18),
            borderRadius: 999,
            paddingHorizontal: 9,
            paddingVertical: 4,
            maxWidth: 220,
          }}
        >
          <Ionicons name={file.kind === 'image' ? 'image-outline' : 'document-attach-outline'} size={13} color="#FFFFFF" />
          <Text numberOfLines={1} style={{ color: '#FFFFFF', fontSize: 12, flexShrink: 1 }}>
            {file.name}
          </Text>
          {file.size ? <Text style={{ color: alpha('#FFFFFF', 70), fontSize: 11 }}>{formatFileSize(file.size)}</Text> : null}
        </Pressable>
      );
    })}
  </View>
);

/**
 * 답 아래의 파일 — 이 답이 작업 공간에 만든 것(요청한 결과물 먼저)과 파일 저장소 결과물·임시 파일.
 * 그림 생성 도구는 같은 그림을 두 곳에 두므로, 작업 공간에 같은 이름이 보이면 한 장만 그린다.
 */
export const AnswerFiles: React.FC<{
  client: XgenMobileClient;
  workflowId: string;
  message: ChatMessage;
  /** 표식을 걷은 본문 — 결과물을 가려낼 근거. */
  text: string;
  downloads: readonly ChatDownload[];
  /** 이 답을 부른 질문 — 요청한 결과물을 고르는 근거. */
  request: string;
  /** 대화의 마지막 답인가(시작 시각을 모르는 되살린 답은 마지막 것만 본다). */
  latest: boolean;
  onOpen: (file: PreviewFile) => void;
}> = ({ client, workflowId, message, text, downloads, request, latest, onOpen }) => {
  const p = useP();
  const [files, setFiles] = useState<WsNode[]>([]);
  const [showOthers, setShowOthers] = useState(false);
  const look = shouldLookForTurnFiles(message, latest);
  const done = message.role === 'assistant' && !message.streaming && !message.remotePartial;
  const { startedAt, lastEventAt } = message;

  useEffect(() => {
    if (!look || !workflowId) return;
    let alive = true;
    workspaceTree(client, workflowId)
      .then((res) => {
        if (alive) setFiles(answerTurnFiles(res.files ?? [], { startedAt, lastEventAt, text }, { latest }));
      })
      .catch(() => {
        // 목록을 못 받으면 아무것도 그리지 않는다(답은 그대로).
      });
    return () => {
      alive = false;
    };
  }, [client, workflowId, look, startedAt, lastEventAt, text, latest]);

  const { requested, others } = useMemo(() => splitRequestedFiles(files, request, text), [files, request, text]);
  const extra = useMemo(
    () => (done ? withoutShownFiles(downloads, files.map((f) => f.name)) : []),
    [done, downloads, files],
  );
  if (!done || (requested.length === 0 && others.length === 0 && extra.length === 0)) return null;

  const openNode = (node: WsNode) => onOpen({ name: node.name, path: node.path, size: node.size });
  const openDownload = (item: ChatDownload) => onOpen({ name: item.name, size: item.size, download: item });
  const nodeCard = (node: WsNode, minor = false) => (
    <FileCard key={node.path} name={node.name} size={node.size} minor={minor} onPress={() => openNode(node)} />
  );
  const downloadCard = (item: ChatDownload) => (
    <FileCard key={item.artifactId ?? `${item.storageId}:${item.fileId}`} name={item.name} size={item.size} onPress={() => openDownload(item)} />
  );

  const images: React.ReactNode[] = [];
  const cards: React.ReactNode[] = [];
  for (const node of requested) {
    const source = isChatImageName(node.name) && (node.size ?? 0) <= IMAGE_INLINE_MAX_BYTES ? workspaceSource(client, workflowId, node.path) : null;
    if (source) {
      images.push(
        <InlineImage key={node.path} source={source} name={node.name} size={node.size} onPress={() => openNode(node)} fallback={nodeCard(node)} />,
      );
    } else cards.push(nodeCard(node));
  }
  for (const item of extra) {
    const source = isChatImageName(item.name) ? downloadSource(client, item) : null;
    const key = item.artifactId ?? `${item.storageId}:${item.fileId}`;
    if (source) {
      images.push(
        <InlineImage key={key} source={source} name={item.name} size={item.size} onPress={() => openDownload(item)} fallback={downloadCard(item)} />,
      );
    } else cards.push(downloadCard(item));
  }

  return (
    <View style={{ gap: 8, marginTop: 8 }} accessibilityLabel="이 답변의 파일">
      {images.length > 0 ? <View style={{ gap: 8 }}>{images}</View> : null}
      {cards.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: p.muted, fontSize: 11, fontWeight: '700' }}>만든 파일</Text>
          {cards}
        </View>
      ) : null}
      {others.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Pressable onPress={() => setShowOthers((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded: showOthers }}>
            <Text style={{ color: p.primary, fontSize: 12, fontWeight: '700' }}>
              {requested.length + extra.length > 0 ? `그 외 ${others.length}개` : `바뀐 파일 ${others.length}개`} {showOthers ? '▾' : '▸'}
            </Text>
          </Pressable>
          {showOthers ? others.map((node) => nodeCard(node, true)) : null}
        </View>
      ) : null}
    </View>
  );
};
