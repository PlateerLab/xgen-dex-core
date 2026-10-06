import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { CanonicalTuiChatModel } from './canonical-chat-model';
import type { CanonicalTuiAccount } from './canonical-types';
import { canonicalTranscript, displayLine, terminalText } from './canonical-display';
import { ImeTextInput } from './ime-text-input';
import { maximumScroll, viewportOf } from './transcript';
import { useTerminalSize } from './use-terminal-size';

type Mode = 'conversation' | 'catalog' | 'message' | 'workflow' | 'title' | 'clear'
  | 'attachments' | 'attachment-path' | 'attachment-discard';

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function CanonicalChatScreen({account, model, onExit}: {
  account: CanonicalTuiAccount; model: CanonicalTuiChatModel; onExit: () => void;
}) {
  const [view,setView] = useState(model.state);
  const [mode,setMode] = useState<Mode>('conversation');
  const [workflow,setWorkflow] = useState(''); const [title,setTitle] = useState('');
  const [attachmentPath,setAttachmentPath] = useState('');
  const [selected,setSelected] = useState(0);
  const [scroll,setScroll] = useState({id:null as string|null,up:0});
  const [inputNotice,setInputNotice] = useState('');
  const {columns,rows} = useTerminalSize();
  const width=Math.max(2,columns); const compact=rows<12;
  const height=Math.max(0,rows-(compact?5:10));
  const sid=view.conversation?.snapshot?.id??null;
  useEffect(()=>model.subscribe(setView),[model]);
  // New focus/credentials revoke any unfinished creation form as well as the model draft.
  useEffect(()=>{setWorkflow('');setTitle('');setAttachmentPath('');setInputNotice('');},[sid]);
  useEffect(()=>{
    setAttachmentPath('');
    setMode((current)=>current==='attachment-path'?(sid?'attachments':'conversation'):current);
  },[view.attachments.epoch]);
  useEffect(()=>{
    if ((mode==='workflow'||mode==='title')&&!view.catalog.canWrite) {
      setWorkflow('');setTitle('');setMode('conversation');
    } else if (mode==='message'&&!view.canEdit) setMode('conversation');
    else if (mode==='attachment-path'&&!view.attachments.canSelect) {
      setAttachmentPath('');setInputNotice('');setMode('conversation');
    }
  },[mode,view.catalog.canWrite,view.canEdit,view.attachments.canSelect]);
  const lines=useMemo(()=>canonicalTranscript(view,width),[view,width]);
  const page=viewportOf(lines,height,scroll.id===sid?scroll.up:0);
  const move=(operation:(value:number)=>number)=>setScroll((old)=>({id:sid,up:operation(old.id===sid?old.up:0)}));
  const safeSelected=Math.min(selected,Math.max(0,view.catalog.items.length-1));
  const safeAttachment=Math.min(selected,Math.max(0,view.attachments.items.length-1));
  const catalogStart=Math.max(0,safeSelected-Math.max(0,height-1));
  const attachmentStart=Math.max(0,safeAttachment-Math.max(0,height-1));
  const perform=(operation:()=>Promise<boolean>,next:Mode='conversation')=>{
    void operation().then((ok)=>{if(ok) setMode(next);}).catch(()=>setInputNotice('작업을 완료할 수 없습니다. 상태를 다시 확인하세요.'));
  };
  useInput((input,key)=>{
    const value=input.toLowerCase();
    if(key.ctrl&&['q','c'].includes(value)){onExit();return;}
    if(key.escape){setMode('conversation');setInputNotice('');return;}
    if(mode==='clear'){
      if(key.return&&view.catalog.canWrite) perform(()=>model.select(null));
      return;
    }
    if(mode==='attachment-discard'){
      if(key.return&&model.discardAttachments()) {setSelected(0);setMode('attachments');}
      return;
    }
    if(['message','workflow','title','attachment-path'].includes(mode)) return;
    if(key.ctrl||key.meta) return;
    if(value==='q'){onExit();return;}
    if(mode==='attachments'){
      if(key.upArrow) setSelected(Math.max(0,safeAttachment-1));
      else if(key.downArrow) setSelected(Math.min(view.attachments.items.length-1,safeAttachment+1));
      else if(value==='a'&&view.attachments.canSelect){setAttachmentPath('');setInputNotice('');setMode('attachment-path');}
      else if(value==='u'&&view.attachments.items[safeAttachment]) perform(()=>model.uploadAttachment(safeAttachment),'attachments');
      else if(value==='r'&&view.attachments.items[safeAttachment]) perform(()=>model.recoverAttachment(safeAttachment),'attachments');
      else if(value==='c'&&view.attachments.items[safeAttachment]) perform(()=>model.cancelAttachment(safeAttachment),'attachments');
      else if(value==='d'&&view.attachments.items.length>0)setMode('attachment-discard');
      return;
    }
    if(value==='r') perform(()=>model.read(),mode);
    else if(value==='w') perform(()=>model.watch(),mode);
    else if(value==='s') {void model.stop();}
    else if(value==='l'){setSelected(0);setMode('catalog');perform(()=>model.loadCatalog(), 'catalog');}
    else if(value==='p'&&mode==='catalog'&&view.catalog.canLoadOlder){setSelected(0);perform(()=>model.loadCatalog(true),'catalog');}
    else if(value==='n'&&view.catalog.canWrite){setWorkflow('');setTitle('');setMode('workflow');}
    else if(value==='x'&&view.catalog.canWrite){setMode('clear');}
    else if(value==='i'&&view.canEdit){setInputNotice('');setMode('message');}
    else if(value==='a'&&snap){setSelected(0);setMode('attachments');}
    else if(value==='y'&&view.turn.canRetry) perform(()=>model.retry());
    else if(value==='t'&&view.turn.canStop) perform(()=>model.stopTurn());
    else if(mode==='catalog'){
      if(key.upArrow) setSelected(Math.max(0,safeSelected-1));
      else if(key.downArrow) setSelected(Math.min(view.catalog.items.length-1,safeSelected+1));
      else if(key.return&&view.catalog.canWrite){const item=view.catalog.items[safeSelected];if(item?.status==='active')perform(()=>model.select(item.id));}
    } else {
      if(key.pageUp||key.upArrow)move((old)=>Math.min(maximumScroll(lines.length,height),old+(key.pageUp?Math.max(1,height-1):1)));
      else if(key.pageDown||key.downArrow)move((old)=>Math.max(0,old-(key.pageDown?Math.max(1,height-1):1)));
      else if(key.home)move(()=>maximumScroll(lines.length,height));
      else if(key.end)move(()=>0);
    }
  });
  const row=(text:string,color?:string)=><Text wrap="truncate" color={color}>{displayLine(text,width)}</Text>;
  const snap=view.conversation?.snapshot;
  const editable=mode==='message'?view.canEdit:mode==='attachment-path'?view.attachments.canSelect:view.catalog.canWrite;
  const inputMode=mode==='message'||mode==='workflow'||mode==='title'||mode==='attachment-path';
  const inputValue=mode==='message'?view.draft:mode==='workflow'?workflow:mode==='title'?title:attachmentPath;
  const change=(value:string)=>{
    const safe=terminalText(value);
    const maxBytes=mode==='message'?262144:mode==='attachment-path'?4096:1024;
    if(new TextEncoder().encode(safe).length>maxBytes) {setInputNotice('입력 길이 상한을 초과했습니다.');return;}
    if(!['message','attachment-path'].includes(mode)&&[...safe].length>256){setInputNotice('최대 256글자까지 입력할 수 있습니다.');return;}
    setInputNotice('');
    if(mode==='message')model.setDraft(safe);
    else if(mode==='workflow')setWorkflow(safe);
    else if(mode==='title')setTitle(safe);
    else setAttachmentPath(safe);
  };
  return <Box flexDirection="column" width={width} height={Math.max(1,rows)} overflow="hidden">
    {row(`Canonical 공유 대화 · ${view.status}${view.writing?' · 쓰기 중':''}`, 'cyan')}
    {!compact&&row(`CLI · ${account.profile} · ${account.origin} · 계정 ${account.userId}`)}
    {!compact&&row(snap?`${snap.title} · ${snap.id}`:'현재 대화: 없음')}
    {!compact&&row(snap?`workflow ${snap.workflow_id} · 버전 ${snap.state_version} · 실행 ${snap.latest_turn?.status??'없음'}`:'L로 목록 조회 후 N으로 생성하거나 기존 세션을 선택하세요.')}
    {row(inputNotice||view.error||(view.catalog.writeBlocked?view.catalog.notice:'')||view.attachments.notice||(snap?view.turn.notice:'')||view.catalog.notice||view.turn.notice||view.notice,view.error?'red':'yellow')}
    <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      {mode==='catalog'?view.catalog.items.slice(catalogStart,catalogStart+height).map((item,index)=><Text key={item.id} color={index+catalogStart===safeSelected?'cyan':item.status==='archived'?'gray':undefined} wrap="truncate">{displayLine(`${index+catalogStart===safeSelected?'>':' '} ${item.title} [${item.status}] ${item.id}`,width)}</Text>)
        :mode==='attachments'?(view.attachments.items.length===0
          ?<Text>{displayLine('첨부 파일이 없습니다. A로 로컬 경로를 입력하세요.',width)}</Text>
          :view.attachments.items.slice(attachmentStart,attachmentStart+height).map((item,index)=>{
            const actual=index+attachmentStart;
            return <Text key={`${actual}:${item.filename}`} color={actual===safeAttachment?'cyan':item.status==='uncertain'?'yellow':item.status==='ready'?'green':undefined} wrap="truncate">{displayLine(`${actual===safeAttachment?'>':' '} ${item.filename} · ${fileSize(item.sizeBytes)} · ${item.mediaType} · ${item.status}`,width)}</Text>;
          }))
        :page.lines.map((line)=><Text key={line.key} color={line.color} wrap="truncate">{line.text||' '}</Text>)}
    </Box>
    {!compact&&row(mode==='catalog'?`소유 세션 ${view.catalog.items.length}개 · ${view.catalog.olderPage?'이전':'최신'} 페이지 · ${view.catalog.hasMore?'P 이전 목록':'끝 페이지'} · 현재 ${view.catalog.focus?.active_agent_session_id??'없음'}`
      :view.hasMore||view.conversation?.omittedMessages||snap?.message_history_complete===false?`일부 기록만 표시 · 생략 ${view.conversation?.omittedMessages??0}개 · R 재조회`:`완료된 검증 본문 · 위 ${page.above}줄 / 아래 ${page.below}줄`, 'gray')}
    {inputMode?<Box height={1} flexShrink={0} overflow="hidden"><Text>{mode==='message'?'메시지: ':mode==='workflow'?'workflow ID: ':mode==='title'?'새 대화 제목: ':'로컬 파일 경로(숨김): '}</Text><ImeTextInput value={inputValue} onChange={change} focus={editable} nativeIme mask={mode==='attachment-path'?'•':undefined} onSubmit={()=>{
      if(!editable||inputNotice) return;
      if(mode==='workflow'&&workflow){setMode('title');}
      else if(mode==='title')perform(()=>model.create(workflow,title));
      else if(mode==='attachment-path'&&attachmentPath) {
        const path=attachmentPath;setAttachmentPath('');perform(()=>model.selectAttachments([path]),'attachments');
      } else if(mode==='message'&&view.turn.canSubmit&&view.attachments.canSubmit)perform(()=>model.submit());
    }}/></Box>:row(mode==='clear'?'현재 공유 대화 선택을 해제할까요? Enter 확인 · Esc 취소'
      :mode==='attachment-discard'?'모든 첨부의 로컬 사본을 버릴까요? Enter 확인 · Esc 취소'
      :mode==='attachments'?`첨부 ${view.attachments.items.length}개 · A 추가 · U 업로드 · R 복구 · C 취소 · D 전체 버리기`
      :`턴 ${view.turn.status} · draft ${new TextEncoder().encode(view.draft).length} bytes · 첨부 ${view.attachments.items.length}개 · ${view.catalog.writeBlocked?'L 최신 목록으로 변경 결과 확인':'I 입력 · A 첨부 · Y 원래 요청 재확인 · T 실행 중단'}`,'yellow')}
    {!compact&&row(`R 조회 · W 실시간 · S 연결 중단 · L 최신 목록 · P 이전 · ${view.catalog.canWrite?'N 생성 · X 선택 해제':'생성/선택 잠금'}`, 'cyan')}
    {row(inputMode?'Enter 확인/송신 · Esc 닫기 · Ctrl+Q 종료':mode==='catalog'?'↑↓ 선택 · Enter 열기 · Esc 대화 · Q 종료':mode==='attachments'?(compact?'A 추가 · U 업로드 · R 복구 · C 취소 · Q 종료':'↑↓ 첨부 선택 · Esc 대화 · Q 종료'):(compact?'I 메시지 · A 첨부 · Q 종료':'I 메시지 · A 첨부 · ↑↓/PgUp/PgDn/Home/End 스크롤 · Q 종료'),'cyan')}
  </Box>;
}
