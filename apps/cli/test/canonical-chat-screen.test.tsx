import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from 'ink-testing-library';
import { DexError } from '@dex/engine';
import type { AgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';
import { AgentTurnComposeFailure, type AgentTurnComposeRequest } from '@dex/protocol/agent-turn-composer';
import { CanonicalTuiChatModel } from '../src/tui/canonical-chat-model';
import { CanonicalChatScreen } from '../src/tui/canonical-chat-screen';
import type { CanonicalTuiChatSource } from '../src/tui/canonical-chat-types';

const account={profile:'corp',origin:'https://app.example.test',userId:'7'};
const sid='11111111-1111-4111-8111-111111111111';
const archived='22222222-2222-4222-8222-222222222222';
const created='33333333-3333-4333-8333-333333333333';
const event='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const turn='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function frame(instance:{lastFrame:()=>string|undefined},predicate:(s:string)=>boolean):Promise<string>{
  for(let i=0;i<150;i++){const value=instance.lastFrame()??'';if(predicate(value)){await new Promise(r=>setTimeout(r,35));return value;}await new Promise(r=>setTimeout(r,5));}
  assert.fail(`Expected chat frame was not rendered: ${instance.lastFrame()}`);
}
function fixture(){
  let binding='a'.repeat(64);let focus={active_agent_session_id:sid as string|null,version:1,event_id:event as string|null};
  let version=2;let running=false;let lost=true;
  const sends:AgentTurnComposeRequest[]=[];const creates:unknown[]=[];const selections:unknown[]=[];
  const conversation=():AgentConversationView=>({snapshot:focus.active_agent_session_id?{
    id:focus.active_agent_session_id,workflow_id:'wf',title:'visible title',current_sequence:4,state_version:version,message_history_complete:true,
    latest_turn:running?{id:turn,status:'running',accepted_sequence:3}:null,
  }:null,messages:[],omittedMessages:0});
  const source:CanonicalTuiChatSource={binding:()=>binding,settle:async()=>{},read:async()=>({conversation:conversation(),has_more:false}),
    watch:async()=>{},catalog:async()=>({binding,focus,sessions:{items:[
      {id:sid,workflow_id:'wf',title:'owned active',status:'active',current_sequence:4,state_version:2},
      {id:archived,workflow_id:'wf',title:'archived row',status:'archived',current_sequence:0,state_version:1},
    ],has_more:false,next_cursor:null}}),
    create:async(_b,input)=>{creates.push(input);focus={active_agent_session_id:created,version:focus.version+1,event_id:event};version=1;return{id:created,workflow_id:input.workflow_id,focus};},
    select:async(_b,input)=>{selections.push(input);focus={...focus,active_agent_session_id:input.active_agent_session_id,version:focus.version+1};return focus;},
    send:async(_b,request)=>{
      sends.push(request);
      if(request.operation==='submit'){
        running=true;version=3;
        if(lost){lost=false;throw new AgentTurnComposeFailure('unknown');}
        return{...request.scope,agent_session_id:request.agent_session_id,mutation:{turn_id:turn,status:'running',accepted_sequence:3,state_version:3,replayed:true}};
      }
      running=false;version=4;
      return{...request.scope,agent_session_id:request.agent_session_id,mutation:{turn_id:turn,state_version:3,requested:true}};
    },
    attachments:()=>[],
    selectAttachments:async()=>[],
    uploadAttachment:async()=>[],
    recoverAttachment:async()=>[],
    cancelAttachment:async()=>[],
    discardAttachments:()=>[],
    attachmentReferences:()=>[],
    clearAttachments:()=>{},
  };
  return{source,sends,creates,selections,changeBinding(){binding='b'.repeat(64);}};
}

test('Ink input keeps navigation and pasted newline as text; explicit original retry and exact stop',async()=>{
  const f=fixture();const model=new CanonicalTuiChatModel(account,f.source,()=> 'one-intent');
  const ui=render(<CanonicalChatScreen account={account} model={model} onExit={()=>assert.fail('Input cannot exit')}/>);
  try{
    await model.read();await frame(ui,s=>s.includes('visible title')&&s.includes('턴 idle')&&model.state.canEdit);
    ui.stdin.write('i');await frame(ui,s=>s.includes('메시지:'));
    ui.stdin.write('rwysqnt');await frame(ui,s=>s.includes('rwysqnt'));
    ui.stdin.write('\u001b[200~');ui.stdin.write('first\nsecond');ui.stdin.write('\u001b[201~');
    await frame(ui,s=>s.includes('first second'));assert.equal(f.sends.length,0);
    ui.stdin.write('\r');await frame(ui,s=>s.includes('턴 unknown')&&model.state.turn.status==='unknown');
    assert.equal(f.sends.length,1);assert.equal(model.state.catalog.canWrite,false);
    ui.stdin.write('r');await frame(ui,s=>s.includes('connected')&&s.includes('실행 running')&&s.includes('턴 unknown')&&model.state.turn.canRetry);
    ui.stdin.write('y');await frame(ui,s=>s.includes('실행 running')&&s.includes('draft 0 bytes')&&model.state.turn.canStop&&!model.state.writing);
    assert.deepEqual(f.sends[1],f.sends[0]);assert.equal(model.state.draft,'');
    ui.stdin.write('t');await frame(ui,s=>s.includes('버전 4')&&f.sends.length===3&&!model.state.writing);
    assert.deepEqual(f.sends[2],{operation:'stop',scope:f.sends[0]!.scope,agent_session_id:sid,input:{turn_id:turn,expected_state_version:3}});
  }finally{ui.unmount();await model.dispose();}
});

test('Ink catalog rejects archived rows, clears selection with confirmation, and creates from visible fields',async()=>{
  const f=fixture();const model=new CanonicalTuiChatModel(account,f.source);
  const fastRead=f.source.read;
  // Real HTTP recovery renders a transient empty view; it must not close the catalog.
  f.source.read=async(signal)=>{await new Promise(r=>setTimeout(r,40));return fastRead(signal);};
  const ui=render(<CanonicalChatScreen account={account} model={model} onExit={()=>{}}/>);
  try{
    await model.read();await frame(ui,s=>s.includes('visible title'));ui.stdin.write('l');await frame(ui,s=>s.includes('owned active')&&model.state.catalog.canWrite);
    ui.stdin.write('\u001b[B');await frame(ui,s=>s.includes('> archived row'));
    ui.stdin.write('\r');await new Promise(r=>setTimeout(r,40));assert.equal(f.selections.length,0);
    ui.stdin.write('x');await frame(ui,s=>s.includes('해제할까요'));
    ui.stdin.write('\u001b');await frame(ui,s=>!s.includes('해제할까요'));assert.equal(f.selections.length,0);
    ui.stdin.write('x');await frame(ui,s=>s.includes('해제할까요'));ui.stdin.write('\r');
    await frame(ui,()=>f.selections.length===1&&!model.state.writing);
    ui.stdin.write('l');await frame(ui,()=>model.state.catalog.canWrite);
    ui.stdin.write('n');await frame(ui,s=>s.includes('workflow ID:'));
    ui.stdin.write('wf');await frame(ui,s=>s.includes('workflow ID: wf'));ui.stdin.write('\r');
    await frame(ui,s=>s.includes('새 대화 제목:'));ui.stdin.write('New Korean 대화');
    await frame(ui,s=>s.includes('New Korean 대화'));ui.stdin.write('\r');
    await frame(ui,()=>f.creates.length===1&&!model.state.writing);
    assert.deepEqual(f.creates[0],{workflow_id:'wf',title:'New Korean 대화',expected_version:2});
  }finally{ui.unmount();await model.dispose();}
});

test('same-session credential replacement discards unfinished create fields; small auth screen remains bounded',async()=>{
  const f=fixture();const model=new CanonicalTuiChatModel(account,f.source);
  const ui=render(<CanonicalChatScreen account={account} model={model} onExit={()=>{}}/>);
  try{
    await model.read();await model.loadCatalog();await frame(ui,()=>model.state.catalog.canWrite);
    ui.stdin.write('n');await frame(ui,s=>s.includes('workflow ID:'));ui.stdin.write('stale-workflow');
    await frame(ui,s=>s.includes('stale-workflow'));f.changeBinding();await model.read();
    await frame(ui,s=>!s.includes('stale-workflow')&&!s.includes('workflow ID:'));
    assert.equal(f.creates.length,0);
    Object.defineProperty(ui.stdout,'rows',{value:8,configurable:true});Object.defineProperty(ui.stdout,'columns',{value:55,configurable:true});ui.stdout.emit('resize');
    f.source.read=async()=>{throw new DexError('auth_required','private token');};await model.read();
    const value=await frame(ui,s=>s.includes('인증')&&s.includes('Q 종료'));
    assert.ok(value.split('\n').length<=8);assert.doesNotMatch(value,/private token|stale-workflow|a{64}|b{64}/);
  }finally{ui.unmount();await model.dispose();}
});

test('Ink attachment form masks local paths and exposes ordered metadata with explicit actions',async()=>{
  const f=fixture();const actions:string[]=[];
  const item={handle:'private-selection',filename:'report\u001b]52;c;LEAK\u0007.txt',sizeBytes:1536,
    mediaType:'application/octet-stream',status:'selected' as const,sha256:'a'.repeat(64)};
  f.source.selectAttachments=async(_binding,_scope,paths)=>{actions.push(`select:${paths[0]}`);return[item];};
  f.source.uploadAttachment=async()=>{actions.push('upload');return[{...item,status:'ready' as const,receipt:{
    origin:account.origin,user_id:account.userId,session_id:sid,workflow_id:'wf',
    attachment_id:'44444444-4444-4444-8444-444444444444',filename:item.filename,
    size_bytes:item.sizeBytes,media_type:item.mediaType,sha256:item.sha256,
  }}];};
  f.source.recoverAttachment=async()=>{actions.push('recover');return[{...item,status:'ready' as const}];};
  f.source.cancelAttachment=async()=>{actions.push('cancel');return[];};
  f.source.discardAttachments=()=>{actions.push('discard');return[];};
  const model=new CanonicalTuiChatModel(account,f.source);
  const ui=render(<CanonicalChatScreen account={account} model={model} onExit={()=>{}}/>);
  try{
    await model.read();await frame(ui,s=>s.includes('visible title'));
    ui.stdin.write('a');await frame(ui,s=>s.includes('첨부 파일이 없습니다'));
    ui.stdin.write('a');await frame(ui,s=>s.includes('로컬 파일 경로(숨김):'));
    ui.stdin.write('/tmp/private file.txt');
    const masked=await frame(ui,s=>s.includes('••••'));
    assert.doesNotMatch(masked,/private file|\/tmp/);
    ui.stdin.write('\r');
    const selectedFrame=await frame(ui,s=>s.includes('1.5 KiB')&&s.includes('selected'));
    assert.match(selectedFrame,/report\.txt/);assert.doesNotMatch(selectedFrame,/LEAK|\u001b|private-selection|a{64}/);
    ui.stdin.write('u');await frame(ui,s=>s.includes('ready')&&actions.includes('upload'));
    ui.stdin.write('r');await frame(ui,()=>actions.includes('recover'));
    ui.stdin.write('c');await frame(ui,s=>s.includes('첨부 파일이 없습니다')&&actions.includes('cancel'));
    assert.deepEqual(actions.slice(0,4),['select:/tmp/private file.txt','upload','recover','cancel']);

    ui.stdin.write('a');await frame(ui,s=>s.includes('로컬 파일 경로(숨김):'));
    ui.stdin.write('/tmp/again.txt');await frame(ui,s=>s.includes('••••'));ui.stdin.write('\r');
    await frame(ui,s=>s.includes('selected'));
    ui.stdin.write('d');await frame(ui,s=>s.includes('모든 첨부의 로컬 사본'));
    ui.stdin.write('\r');await frame(ui,s=>s.includes('첨부 파일이 없습니다')&&actions.includes('discard'));
  }finally{ui.unmount();await model.dispose();}
});

test('same-session credential replacement closes the masked path form without replaying its value',async()=>{
  const f=fixture();const selected:string[][]=[];
  f.source.selectAttachments=async(_binding,_scope,paths)=>{selected.push([...paths]);return[];};
  const model=new CanonicalTuiChatModel(account,f.source);
  const ui=render(<CanonicalChatScreen account={account} model={model} onExit={()=>{}}/>);
  try{
    await model.read();await frame(ui,s=>s.includes('visible title'));
    ui.stdin.write('a');await frame(ui,s=>s.includes('첨부 파일이 없습니다'));
    ui.stdin.write('a');await frame(ui,s=>s.includes('로컬 파일 경로(숨김):'));
    ui.stdin.write('/tmp/old-auth-private.txt');await frame(ui,s=>s.includes('••••'));
    f.changeBinding();await model.read();
    const replaced=await frame(ui,s=>!s.includes('로컬 파일 경로(숨김):'));
    assert.doesNotMatch(replaced,/old-auth-private|\/tmp/);
    ui.stdin.write('\r');await new Promise(r=>setTimeout(r,30));
    assert.deepEqual(selected,[]);
  }finally{ui.unmount();await model.dispose();}
});

test('authentication loss closes and clears an in-progress masked attachment path',async()=>{
  const f=fixture();const selected:string[][]=[];
  f.source.selectAttachments=async(_binding,_scope,paths)=>{selected.push([...paths]);return[];};
  const model=new CanonicalTuiChatModel(account,f.source);
  const ui=render(<CanonicalChatScreen account={account} model={model} onExit={()=>{}}/>);
  try{
    await model.read();await frame(ui,s=>s.includes('visible title'));
    ui.stdin.write('a');await frame(ui,s=>s.includes('첨부 파일이 없습니다'));
    ui.stdin.write('a');await frame(ui,s=>s.includes('로컬 파일 경로(숨김):'));
    ui.stdin.write('/tmp/revoked-private.txt');await frame(ui,s=>s.includes('••••'));
    f.source.read=async()=>{throw new DexError('auth_required','private credential detail');};
    await model.read();
    const stopped=await frame(ui,s=>s.includes('인증')&&!s.includes('로컬 파일 경로(숨김):'));
    assert.doesNotMatch(stopped,/revoked-private|\/tmp|private credential detail/);
    ui.stdin.write('\r');await new Promise(r=>setTimeout(r,30));
    assert.deepEqual(selected,[]);
  }finally{ui.unmount();await model.dispose();}
});
