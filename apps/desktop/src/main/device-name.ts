/**
 * 이 PC 의 이름 — 클라우드 안에서 폴더가 되는 그 이름.
 *
 *     {XgenCloud} / {PC 이름} / (파일)
 *
 * **로컬 로그인 이름은 여기 들어갈 이유가 없다.** 클라우드는 이미 XGEN 계정으로
 * 갈린다 — A 계정의 클라우드에 닿을 수 있는 것은 A 로 로그인한 커넥터뿐이다.
 * 그 안에서 폴더를 나누는 축은 "누구" 가 아니라 "어느 기기" 다.
 *
 * 그런데 리눅스·맥 배포판은 설치할 때 호스트명을 `{로그인이름}-{모델}` 로
 * 만들어 둔다. 그대로 쓰면 클라우드에 `hrjang-Crosshair-17-HX-D14VGKG` 같은
 * 폴더가 생긴다 — 앞의 `hrjang` 은 이 트리 안에서 아무것도 구분하지 않는
 * 잡음이고, 계정 이름과 다르기까지 하면 사용자를 헷갈리게 한다.
 *
 * 그래서 기본값에서 그 접두사만 걷어낸다. 걷어내고 남는 게 없으면 원래
 * 호스트명을 쓴다 — 이름이 없는 것보다 잡음이 낫다.
 *
 * **사용자가 바꿀 수 없게 두는 이유**: 이 이름은 클라우드 안 폴더가 되고, 폴더는
 * 데이터의 주소다. 이름을 바꿀 수 있게 하면 주소가 따라 움직이고 그 안의 파일은
 * 예전 자리에 남는다 — 이사가 아니라 분실이다. 서버도 같은 이유로 폴더를 처음
 * 등록될 때 한 번만 정하고 이후 어떤 이름 변경에도 움직이지 않는다.
 *
 * 그래서 이건 **표시 이름**을 만드는 규칙일 뿐이다. 주소는 서버가 못 박아 둔다.
 */

/** 호스트명 앞에 붙은 로컬 로그인 이름을 걷어낸 기본 PC 이름. */
export function defaultDeviceName(hostname: string, localUser: string): string {
  const host = String(hostname || '').trim()
  const user = String(localUser || '').trim()
  if (!host) return user || 'PC'
  if (!user) return host

  // `hrjang-Crosshair-17` · `hrjang.local` · `hrjangs-MacBook-Pro`
  const lower = host.toLowerCase()
  const u = user.toLowerCase()
  for (const prefix of [`${u}-`, `${u}_`, `${u}.`, `${u}s-`, `${u}'s-`]) {
    if (lower.startsWith(prefix)) {
      const rest = host.slice(prefix.length).trim()
      // 접두사를 떼고 나면 아무것도 안 남는 경우(호스트명이 곧 로그인 이름)는
      // 원래 이름을 쓴다. 빈 이름은 폴더가 될 수 없다.
      if (rest) return rest
    }
  }
  // 호스트명이 곧 로그인 이름이면 그대로 둔다 — 지우면 남는 게 없다.
  return host
}

