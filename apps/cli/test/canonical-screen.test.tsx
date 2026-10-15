import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render } from 'ink-testing-library';
import { DexError, type NativeAgentConversationUpdate } from '@dex/engine';
import { CanonicalTuiController } from '../src/tui/canonical-controller';
import { CanonicalScreen } from '../src/tui/canonical-screen';
import type { CanonicalTuiSource } from '../src/tui/canonical-types';
import type { AgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';

const account = {profile:'corp', origin:'https://app.example.test', userId:'7'};
const conversation: AgentConversationView = {
  snapshot:{id:'018f1240-0000-7000-8000-000000000002', workflow_id:'wf', title:'safe\u001b]52;c;clipboard\u0007', current_sequence:2, state_version:1, message_history_complete:false, latest_turn:{id:'018f1240-0000-7000-8000-000000000003', status:'running', accepted_sequence:1}},
  messages:[{turn_id:'018f1240-0000-7000-8000-000000000003', sequence:2, status:'completed', input_text:'first line\n' + '긴 본문\n'.repeat(200), output_text:'last verified answer', content_complete:true, source:'user'}], omittedMessages:2,
};
async function frame(instance: {lastFrame:()=>string|undefined}, predicate:(value:string)=>boolean):Promise<string> {
  for (let i=0;i<150;i++) { const value=instance.lastFrame()??''; if(predicate(value)) { await new Promise((resolve)=>setTimeout(resolve,35)); return value; } await new Promise((resolve)=>setTimeout(resolve,5)); }
  assert.fail(`Expected TUI frame was not rendered:\n${instance.lastFrame()}`);
}
test('real Ink keys connect read/watch/stop, scroll bounded transcript, and clear private content', async () => {
  let reads=0; let watches=0; let exits=0; let update: ((value:NativeAgentConversationUpdate)=>void)|undefined;
  const source:CanonicalTuiSource = {read:async()=>{reads++; return {conversation,has_more:false};}, watch:async(callback,signal)=>{
    watches++; update=callback;
    callback({type:'conversation', user_id:'7', conversation, has_more:false, source:'snapshot'});
    await new Promise<void>((resolve)=>{signal.addEventListener('abort',()=>resolve(),{once:true}); if(signal.aborted) resolve();});
  }, settle:async()=>undefined};
  const controller=new CanonicalTuiController(source,'7');
  const instance=render(<CanonicalScreen account={account} controller={controller} onExit={()=>{exits++;}}/>);
  try {
    await frame(instance,(s)=>s.includes('조회 전용'));
    instance.stdin.write('r');
    const read=await frame(instance,(s)=>s.includes('last verified answer'));
    assert.equal(reads,1); assert.match(read,/실행 running/); assert.match(read,/일부 기록만 표시/);
    assert.doesNotMatch(read,/clipboard|\u001b\]52/); assert.ok(read.split('\n').length<=30);
    instance.stdin.write('\u001b[H');
    await frame(instance,(s)=>s.includes('first line') && !s.includes('last verified answer'));
    instance.stdin.write('\u001b[F'); await frame(instance,(s)=>s.includes('last verified answer'));
    instance.stdin.write('w'); await frame(instance,()=>watches===1);
    update?.({type:'reset',user_id:'7'});
    await frame(instance,(s)=>!s.includes('last verified answer')&&!s.includes('실행 running'));
    instance.stdin.write('s'); await frame(instance,(s)=>s.includes('stopped'));
    instance.stdin.write('\u0011'); await frame(instance,()=>exits===1);
  } finally {instance.unmount(); await controller.dispose();}
});
test('short terminal keeps authentication notice and exit controls visible without private bodies', async () => {
  const source: CanonicalTuiSource = { read:async()=>{throw new DexError('auth_required','private token');}, watch:async()=>undefined, settle:async()=>undefined };
  const controller = new CanonicalTuiController(source, '7');
  const instance = render(<CanonicalScreen account={account} controller={controller} onExit={()=>undefined}/>);
  try {
    Object.defineProperty(instance.stdout, 'rows', {value:8, configurable:true});
    Object.defineProperty(instance.stdout, 'columns', {value:55, configurable:true});
    instance.stdout.emit('resize');
    await controller.read();
    const value = await frame(instance,(s)=>s.includes('인증이 필요')&&s.includes('Q 종료'));
    assert.ok(value.split('\n').length<=8);
    assert.doesNotMatch(value,/private token|last verified answer/);
  } finally {instance.unmount(); await controller.dispose();}
});
