import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentTurnComposer, type AgentTurnComposeRequest } from '../src/agent-turn-composer';

test('CLI composer preserves its platform scope through original-request reconciliation', async () => {
  const sid = '018f1240-0000-7000-8000-000000000001';
  const turn = '018f1240-0000-7000-8000-000000000002';
  const calls: AgentTurnComposeRequest[] = [];
  const composer = new AgentTurnComposer(async (request) => {
    calls.push(request);
    return { ...request.scope, agent_session_id:sid, mutation:{turn_id:turn,status:'accepted',accepted_sequence:1,state_version:2,replayed:false} };
  },()=>undefined,()=> 'cli-request-1');
  composer.context({platform_type:'cli',profile:'corp',server_url:'https://app.example.test',user_id:'7'}, {
    id:sid,workflow_id:'wf',title:'CLI',current_sequence:0,state_version:1,message_history_complete:true,latest_turn:null,
  },true);
  await composer.submit('same exact message');
  assert.equal(calls[0]!.scope.platform_type,'cli');
  assert.equal(calls[0]!.input.expected_state_version,1);
  assert.equal(composer.view.status,'accepted');
  assert.equal(composer.view.canSubmit,false);
});
