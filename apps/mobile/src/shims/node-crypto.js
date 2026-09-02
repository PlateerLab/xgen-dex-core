// metro 전용 가짜 'node:crypto' — protocol/hash.ts 의 Node 폴백 경로는 RN 에서
// crypto shim 이 선행 설치되므로 절대 실행되지 않는다. 번들 해석용 껍데기.
module.exports = { webcrypto: globalThis.crypto };
