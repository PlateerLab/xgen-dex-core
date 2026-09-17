/**
 * 답변 피드백 — 별점과 문제 유형.
 *
 * 웹 채팅에만 있던 기능이라 앱에서 답을 평가할 길이 없었다. 평가가 한쪽 화면에서만 걷히면
 * 관리자 화면의 [사용자 피드백] 은 "웹에서 쓴 사람" 만 보게 된다.
 *
 * 서버는 실행 한 건(`execution_io_id`)마다 사용자 한 명의 피드백을 들고 있고, 같은 실행에 다시
 * 등록하면 갱신한다. 그래서 화면은 "등록/수정" 을 나누지 않아도 되고, 지운 뒤 다시 쓸 수도 있다.
 */
import { HttpClient } from './client';

/**
 * 문제 유형 — 서버 `UserFeedback.ISSUE_TYPES` 와 **같은 값**이어야 한다.
 *
 * 관리자 화면의 [사용자 피드백] 은 이 값으로 센다. 앱이 자기 말로 번역해 보내면 같은 불만이
 * 두 종류로 갈려 집계가 갈라진다. 그래서 목록을 여기 한 곳에 두고 앱들이 가져다 쓴다.
 */
export const FEEDBACK_ISSUE_TYPES = [
  '이슈없음',
  '규정 위반',
  '데이터 오류',
  '환각(허위 정보)',
  '응답 실패',
  '기타',
] as const;

export type FeedbackIssueType = (typeof FEEDBACK_ISSUE_TYPES)[number];

export interface ChatFeedback {
  id: number;
  executionIoId: number;
  starRating: number;
  issueType: string;
  comment?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface RawFeedback {
  id: number;
  execution_io_id: number;
  star_rating: number;
  issue_type: string;
  comment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const toFeedback = (r: RawFeedback): ChatFeedback => ({
  id: r.id,
  executionIoId: r.execution_io_id,
  starRating: r.star_rating,
  issueType: r.issue_type,
  comment: r.comment ?? null,
  createdAt: r.created_at ?? null,
  updatedAt: r.updated_at ?? null,
});

export class FeedbackApi {
  constructor(private http: HttpClient) {}

  /** 별점·문제 유형을 남긴다. 이미 남긴 실행이면 서버가 갱신한다. */
  async submit(input: {
    executionIoId: number;
    starRating: number;
    issueType: string;
    comment?: string;
  }): Promise<ChatFeedback> {
    const res = await this.http.post<{ data: RawFeedback }>('/api/agentflow/feedback', {
      execution_io_id: input.executionIoId,
      star_rating: input.starRating,
      issue_type: input.issueType,
      ...(input.comment ? { comment: input.comment } : {}),
    });
    return toFeedback(res.data);
  }

  /** 이미 남긴 것을 고친다. */
  async update(
    feedbackId: number,
    input: { starRating?: number; issueType?: string; comment?: string },
  ): Promise<ChatFeedback> {
    const res = await this.http.put<{ data: RawFeedback }>(`/api/agentflow/feedback/${feedbackId}`, {
      ...(input.starRating !== undefined ? { star_rating: input.starRating } : {}),
      ...(input.issueType !== undefined ? { issue_type: input.issueType } : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    });
    return toFeedback(res.data);
  }

  async remove(feedbackId: number): Promise<void> {
    await this.http.del(`/api/agentflow/feedback/${feedbackId}`);
  }

  /**
   * 이 실행들에 내가 남긴 피드백 — 대화를 열 때 한 번에 읽는다.
   *
   * 답변마다 물어보면 대화 하나를 열 때 수십 번을 부르게 된다. 빈 목록을 물어보지도 않는다.
   */
  async mine(executionIoIds: readonly (number | string)[]): Promise<ChatFeedback[]> {
    const ids = executionIoIds.filter((id) => id !== undefined && id !== null);
    if (ids.length === 0) return [];
    const params = new URLSearchParams({ execution_io_ids: ids.join(',') });
    const res = await this.http.get<{ items?: RawFeedback[] }>(
      `/api/agentflow/feedback/me?${params}`,
    );
    return (res.items ?? []).map(toFeedback);
  }
}
