-- 턴(agent_traces 한 줄)과 그 도구 기록(agent_trace_spans)을 한 줄에 하나씩 JSON 으로 내보낸다 — measure-turns.mjs 가 읽는다.
-- 도구 입력은 내보내지 않는다(로그인 칸 값이 들어 있을 수 있다). 출력에도 자료 파일 내용이 들어 있으니 내보낸 파일은
-- 저장소에 넣지 말고 다 본 뒤 지운다.
--
--   psql -At -v uid=128 -v since='2026-10-23 09:20+00' -v wf='fast-act-%' -f measure-turns.sql > spans.jsonl
select row_to_json(x) from (
  select t.id as trace,
         to_char(t.created_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI:SS') as ts,
         t.workflow_name as wf,
         t.interaction_id as iid,
         t.status,
         t.duration_ms as trace_ms,
         t.total_llm_calls as llm,
         t.total_tool_calls as tools,
         t.metadata::jsonb -> 'usage' as usage,
         s.span_order as o,
         s.span_type as type,
         s.tool_name as tool,
         left(s.output_data, 6000) as out,
         left(s.error_message, 600) as err,
         s.duration_ms as ms
  from agent_traces t
  left join agent_trace_spans s on s.trace_id = t.trace_id
  where t.user_id = :'uid' and t.created_at >= :'since' and t.workflow_name like :'wf'
  order by t.id, s.span_order
) x;
