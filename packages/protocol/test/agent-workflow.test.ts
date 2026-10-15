/**
 * 에이전트 뷰어가 저장된 워크플로우를 읽는 법.
 *
 * 지키는 것: Geny 인지는 노드로 정한다(Agent Geny RSI 도 Geny 계열이다), Geny 가 아닌 에이전트의 [개요]는
 * 저장된 정의만으로 종류 · 모델 · 시스템 프롬프트 · 연결을 말한다, 만들기 응답의 노드 종류를 버리지 않는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { summarizeWorkflow, toAgentWorkflow, workflowHasGeny } from '@dex/protocol/agent-workflow'
import { AgentsApi } from '@dex/protocol/agents'

const xgenWorkflow = toAgentWorkflow('wf_1', {
  workflow_id: 'wf_1',
  workflow_name: '상담봇',
  owner_user_id: 7,
  nodes: [
    { id: 'n1', data: { id: 'input_string', nodeName: 'Input String', nodeNameKo: '입력' } },
    {
      id: 'n2',
      data: {
        id: 'agents/xgen',
        functionId: 'agents',
        nodeName: 'Agent Xgen',
        parameters: [
          { id: 'provider', value: 'openai', options: [{ value: 'openai', label: 'OpenAI' }] },
          { id: 'openai_model', value: 'gpt-4o' },
          { id: 'system_prompt', value: '  친절하게 답한다  ' },
        ],
        inputs: [{ id: 'text', name: 'Text', name_ko: '질문' }],
      },
    },
    { id: 'n3', data: { id: 'tools/print_agent_output', nodeName: 'Print' } },
  ],
  edges: [
    { source: { nodeId: 'n1', portId: 'text' }, target: { nodeId: 'n2', portId: 'text' } },
    { source: { nodeId: 'n2', portId: 'stream' }, target: { nodeId: 'n3', portId: 'input_print' } },
  ],
})

test('Agent Xgen 워크플로우를 사람이 읽을 말로 추린다', () => {
  assert.equal(xgenWorkflow.ownerUserId, '7')
  assert.equal(xgenWorkflow.isFrozen, false)
  assert.equal(workflowHasGeny(xgenWorkflow), false)
  const summary = summarizeWorkflow(xgenWorkflow)
  assert.equal(summary.agentNodeType, 'agents/xgen')
  assert.equal(summary.kind, 'Agent Xgen')
  assert.equal(summary.model, 'OpenAI · gpt-4o')
  assert.equal(summary.prompt, '친절하게 답한다')
  assert.deepEqual(summary.connected, [{ key: 'n1:text', name: '입력', port: '질문' }])
  assert.equal(summary.nodeCount, 3)
  assert.equal(summary.edgeCount, 2)
})

test('에이전트 노드가 없으면 일반 워크플로우, Geny 계열이면 Geny', () => {
  const plain = toAgentWorkflow('wf_2', { content: { nodes: [{ id: 'a', data: { id: 'input_string' } }], edges: [] } })
  assert.equal(summarizeWorkflow(plain).kind, '일반 워크플로우')
  assert.equal(summarizeWorkflow(plain).prompt, null)
  for (const type of ['agents/geny', 'agents/geny-rsi']) {
    assert.equal(workflowHasGeny(toAgentWorkflow('wf_3', { nodes: [{ id: 'g', data: { id: type } }] })), true)
  }
  assert.equal(toAgentWorkflow('wf_4', { is_frozen: true, owner_user_id: null }).isFrozen, true)
})

test('만들기 응답의 노드 종류와 이름 바꾸기 경로', async () => {
  const calls: Array<{ path: string; body?: unknown }> = []
  const http = {
    post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ path, body })
      if (path === '/api/agentflow/create')
        return Promise.resolve({ workflow_id: 'wf_9', workflow_name: 'a', agent_node_type: 'agents/xgen', node_count: 3 } as T)
      return Promise.resolve({ workflow_id: 'wf_9', name: '새 이름' } as T)
    },
  }
  const api = new AgentsApi(http as never)
  assert.deepEqual(await api.create({ name: 'a', provider: 'openai' }), {
    workflowId: 'wf_9',
    workflowName: 'a',
    agentNodeType: 'agents/xgen',
    nodeCount: 3,
  })
  assert.deepEqual(await api.rename('wf_9', '새 이름'), { workflowId: 'wf_9', workflowName: '새 이름' })
  assert.deepEqual(calls[1], { path: '/api/agentflow/basic-info/wf_9', body: { name: '새 이름' } })
})

test('이름이 겹치면 이유를 문장으로 돌려준다', async () => {
  const { ApiError } = await import('@dex/protocol/client')
  const http = {
    post(): Promise<never> {
      return Promise.reject(new ApiError(400, 'POST → 400', { detail: 'A workflow with the new name already exists' }))
    },
  }
  await assert.rejects(new AgentsApi(http as never).rename('wf_9', 'a'), /같은 이름의 에이전트가 이미 있습니다/)
})
