import type {
  GeneratedContentProvenance,
  GeneratedContentVerificationStatus,
} from '@dex/protocol';

export type ProvenanceCheckState = GeneratedContentVerificationStatus | 'checking' | 'failed';

export interface ProvenanceMessageState {
  text: string;
  generatedContent?: GeneratedContentProvenance[];
  malformedGeneratedContent?: boolean;
  provenanceFinal?: boolean;
  provenanceCheck?: ProvenanceCheckState;
}

export type TextVerificationCandidate =
  | { ok: true; proof: string | null; text: string }
  | { ok: false; reason: 'malformed' | 'media_only' | 'ambiguous' };

function isObservedText(item: GeneratedContentProvenance): boolean {
  return item.content_type === 'text/plain' && !item.artifact_path;
}

/** Only an exact single text declaration can be checked against the displayed text. */
export function textVerificationCandidate(message: ProvenanceMessageState): TextVerificationCandidate {
  if (message.malformedGeneratedContent) return { ok: false, reason: 'malformed' };
  const declarations = message.generatedContent ?? [];
  if (declarations.length === 0) return { ok: true, proof: null, text: message.text };
  const text = declarations.filter(isObservedText);
  if (text.length === 0) return { ok: false, reason: 'media_only' };
  if (text.length !== 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, proof: text[0].proof, text: message.text };
}

export function provenanceLabel(message: ProvenanceMessageState): string | undefined {
  if (message.provenanceCheck === 'checking') return '본문 출처 확인 중';
  if (message.provenanceCheck === 'verified') return '본문 출처 확인됨';
  if (message.provenanceCheck === 'changed') return '본문이 바뀌어 확인되지 않음';
  if (message.provenanceCheck === 'other_actor') return '다른 계정의 서명';
  if (message.provenanceCheck === 'invalid') return '서명이 유효하지 않음';
  if (message.provenanceCheck === 'unsigned_legacy') return '서명 정보 없음';
  if (message.provenanceCheck === 'unavailable') return '출처 확인을 사용할 수 없음';
  if (message.provenanceCheck === 'failed') return '본문 출처 확인 실패';
  if (message.malformedGeneratedContent) return '출처 정보 손상';
  if ((message.generatedContent?.length ?? 0) > 0) return 'AI 생성 표시 · 확인 전';
  if (message.provenanceFinal) return '출처 정보 없음';
  return undefined;
}
