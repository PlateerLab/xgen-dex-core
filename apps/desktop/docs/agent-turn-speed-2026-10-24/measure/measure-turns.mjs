#!/usr/bin/env node
/**
 * 턴마다 시간·LLM 호출·도구 쓰임을 센다 — 소민 프롬프트 규칙을 뺀 전후를 같은 잣대로 비교하려고.
 *
 *   node measure-turns.mjs spans.jsonl [--trace 54682,54683] [--iid conn-wf_…]   (Node 22 — Map.groupBy)
 *
 * 입력은 measure-turns.sql 이 내보낸 줄(턴 열 + 도구 기록 열). 도구 출력은 분류에만 쓰고 찍지 않는다 — 자료 파일과
 * 로그인 정보가 들어 있을 수 있다. DB 의 출력은 약 4,000자에서 잘리므로 BrowserFill 줄 수는 잘린 만큼 덜 셀 수 있다.
 */
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: node measure-turns.mjs spans.jsonl [--trace id,id] [--iid interaction]');
  process.exit(2);
}
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const onlyTraces = new Set((opt('--trace') ?? '').split(',').filter(Boolean).map(Number));
const onlyIid = opt('--iid');

const rows = readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const turns = new Map();
for (const r of rows) {
  if (onlyTraces.size && !onlyTraces.has(r.trace)) continue;
  if (onlyIid && r.iid !== onlyIid) continue;
  if (!turns.has(r.trace)) turns.set(r.trace, { head: r, spans: [] });
  turns.get(r.trace).spans.push(r);
}

const FILE_TOOLS = new Set(['UserPc', 'Bash', 'Read', 'Write', 'Edit', 'ParseDocument']);
const browser = (tool) => (tool ?? '').replace(/^mcp_local_/, '');
const count = (text, re) => (text.match(re) ?? []).length;
// 엑셀 한 장을 읽어 낸 출력 — 시트 표시나 머리글 행.
const sheetRead = (out) => /SHEET|^\s*[[({]\s*['"]상품명['"]/m.test(out) || /['"]상품명['"]\s*[:,]/.test(out);
// 파일 읽기 실패의 종류(4f 에서 센 것과 같은 잣대).
const fileFailure = (out) =>
  /IsADirectoryError|cannot overwrite directory/.test(out) ? 'dir'
    : /FileNotFoundError|No such file/.test(out) ? 'missing'
      : /could not move .*Permission denied/.test(out) ? 'move'
        : /init_import_site|No module named 'encodings'|libxcrun/.test(out) ? 'python'
          : /Traceback|Exit code: [1-9]|\bexit [1-9]/.test(out) ? 'other' : null;

function measure({ head, spans }) {
  const calls = spans.filter((s) => s.type === 'tool_call');
  const outs = spans.filter((s) => s.type === 'tool_output');
  const by = {};
  for (const c of calls) by[browser(c.tool)] = (by[browser(c.tool)] ?? 0) + 1;

  // Fill 바로 다음 브라우저 도구가 Snapshot·FormValues 면 "결과를 두고 다시 읽음".
  const seq = calls.map((c) => browser(c.tool)).filter((t) => t.startsWith('Browser'));
  let rereads = 0;
  seq.forEach((t, i) => { if (t === 'BrowserFill' && /^Browser(Snapshot|FormValues)$/.test(seq[i + 1] ?? '')) rereads++; });

  const fill = { steps: 0, failed: 0, skipped: 0, retried: 0, unchanged: 0, incomplete: 0 };
  for (const o of outs.filter((s) => browser(s.tool) === 'BrowserFill')) {
    const text = o.out ?? '';
    fill.steps += count(text, /"status":"(done|failed|skipped)"/g);
    fill.failed += count(text, /"status":"failed"/g);
    fill.skipped += count(text, /"status":"skipped"/g);
    fill.retried += count(text, /"retried":true/g);
    fill.unchanged += count(text, /"unchanged":true/g);
    fill.incomplete += count(text, /"complete":false/g);
  }

  const fileOuts = outs.filter((s) => FILE_TOOLS.has(s.tool));
  const firstRead = fileOuts.findIndex((s) => sheetRead(s.out ?? ''));
  const failures = {};
  for (const s of fileOuts) {
    const kind = fileFailure(`${s.err ?? ''}\n${s.out ?? ''}`);
    if (kind) failures[kind] = (failures[kind] ?? 0) + 1;
  }
  const denied = outs.filter((s) => /^(user_denied|browser_denied)/m.test(s.out ?? s.err ?? '')).length;
  // 도구는 하나씩 돌므로 턴 시간에서 도구 시간을 뺀 나머지가 대략 모델 시간이다(llm_call 기록에는 시간이 없다).
  const toolMs = (name) => outs.filter((s) => !name || browser(s.tool) === name).reduce((a, s) => a + (s.ms ?? 0), 0);
  const usage = head.usage ?? {};
  return {
    trace: head.trace,
    ts: head.ts,
    wf: head.wf,
    status: head.status,
    sec: Math.round((head.trace_ms ?? 0) / 100) / 10,
    llm: head.llm,
    tools: calls.length,
    toolSec: Math.round(toolMs() / 100) / 10,
    navigateSec: Math.round(toolMs('BrowserNavigate') / 100) / 10,
    fillSec: Math.round(toolMs('BrowserFill') / 100) / 10,
    firstPromptK: usage.first_call_prompt_tokens ? Math.round(usage.first_call_prompt_tokens / 100) / 10 : null,
    maxPromptK: usage.max_call_prompt_tokens ? Math.round(usage.max_call_prompt_tokens / 100) / 10 : null,
    cacheReadK: Math.round((usage.cache_read_tokens ?? 0) / 100) / 10,
    fill: by.BrowserFill ?? 0,
    fillSteps: fill,
    snapshot: by.BrowserSnapshot ?? 0,
    rereadAfterFill: rereads,
    interact: by.BrowserInteract ?? 0,
    navigate: by.BrowserNavigate ?? 0,
    fileCalls: calls.filter((c) => FILE_TOOLS.has(c.tool)).length,
    callsToSheet: firstRead >= 0 ? firstRead + 1 : null,
    fileFailures: failures,
    denied,
    toolErrors: outs.filter((s) => s.err).length,
  };
}

const results = [...turns.values()].map(measure);
const kv = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
console.log('| trace | 기록 시각 | workflow | 상태 | 초 | 도구 초(Navigate·Fill) | LLM | 도구 | 요청 k토큰(첫/최대/캐시 읽기 합) | Fill(줄: 실패·재시도·그대로) | Fill 뒤 다시 읽기 | Snapshot | Interact | 파일 도구(엑셀까지) | 파일 실패 | 도구 오류 | 거절 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const f = r.fillSteps;
  console.log(`| ${r.trace} | ${r.ts} | ${r.wf} | ${r.status} | ${r.sec} | ${r.toolSec}(${r.navigateSec}·${r.fillSec}) | ${r.llm} | ${r.tools} | ${r.firstPromptK ?? '-'}/${r.maxPromptK ?? '-'}/${r.cacheReadK} | ${r.fill}(${f.steps}: ${f.failed}·${f.retried}·${f.unchanged}) | ${r.rereadAfterFill} | ${r.snapshot} | ${r.interact} | ${r.fileCalls}(${r.callsToSheet ?? '-'}) | ${kv(r.fileFailures)} | ${r.toolErrors} | ${r.denied} |`);
}
// workflow(프롬프트판)마다 합 — A·B 를 같은 내보내기에 담아 한 번에 비교한다.
const keys = ['sec', 'toolSec', 'navigateSec', 'fillSec', 'llm', 'tools', 'cacheReadK', 'fill', 'snapshot', 'interact', 'fileCalls', 'toolErrors', 'denied'];
const groups = Map.groupBy(results, (r) => r.wf);
console.log('\n| workflow | 턴 | ' + keys.join(' | ') + ' |');
console.log('|---|---|' + keys.map(() => '---|').join(''));
for (const [wf, rs] of groups) {
  const sums = keys.map((k) => Math.round(rs.reduce((a, r) => a + r[k], 0) * 10) / 10);
  console.log(`| ${wf} | ${rs.length} | ${sums.join(' | ')} |`);
}
