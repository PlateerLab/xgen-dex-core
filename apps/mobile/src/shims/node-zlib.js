// metro 전용 가짜 'node:zlib' — 내장 셸(just-bash)의 gzip·gunzip·tar.gz 가 부른다. 휴대폰에는 zlib 이 없어
// 그 명령은 지원하지 않는다고 답한다(불러올 때가 아니라 쓸 때 실패한다).
function unsupported() {
  throw new Error('gzip is not available on this phone');
}
module.exports = { constants: {}, gzipSync: unsupported, gunzipSync: unsupported };
