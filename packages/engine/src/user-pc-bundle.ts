/**
 * 내장 bash 해석기(just-bash, user-pc-builtin)를 앱 번들에 녹일 때 빼는 패키지 — 엔진을 묶는 앱(데스크톱·XD)의
 * 빌드 설정이 이 목록을 읽는다.
 *
 * 몇 명령만 쓰는 큰 패키지(다 실으면 설치본이 90MB 는다)이거나 just-bash 의 선택 의존(설치되지 않을 수 있다)이다.
 * 해석기는 그 명령을 등록하지 않으므로(user-pc-builtin 의 BUILTIN_LEFT_OUT_COMMANDS) 빠진 패키지를 부를 일이
 * 없다. guarded-fetch 는 네트워크 명령용이다(해석기는 네트워크를 켜지 않는다).
 */
export const JUST_BASH_LEFT_OUT_PACKAGES = [
  'sql.js',
  'turndown',
  'run',
  'typescript',
  'guarded-fetch',
  'node-liblzma',
  '@mongodb-js/zstd',
];
