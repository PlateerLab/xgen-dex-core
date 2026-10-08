// metro 전용 가짜 'turndown' — 내장 셸(just-bash)의 html-to-markdown 명령만 쓴다. 휴대폰에서는 그 명령을 쓰지
// 않는다(브라우저 판은 DOMParser 를 부르는데 React Native 에는 없다).
module.exports = function TurndownService() {
  throw new Error('html-to-markdown is not available on this phone');
};
