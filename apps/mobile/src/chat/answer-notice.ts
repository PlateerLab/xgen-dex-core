/**
 * 답변이 끝났는데 앱이 뒤에 있을 때 — 알림 하나.
 *
 * 폰은 화면을 끄고 주머니에 넣는 기계다. 긴 답변을 기다리는 동안 다른 앱을 보는
 * 것이 정상이고, 그러면 답이 끝난 것을 알 길이 없어 사용자는 몇 분마다 앱을
 * 열어 확인했다. 데스크톱에는 창이 뒤에 있을 때 알리는 자리가 있는데 모바일에는
 * 없었다.
 *
 * 규칙:
 *   · **앞에 있으면 알리지 않는다** — 보고 있는 화면에 대한 알림은 방해다.
 *   · 권한은 처음 필요한 순간에만 묻는다(앱을 켜자마자 묻지 않는다).
 *   · 실패는 조용히 지나간다 — 알림은 대화의 곁가지지, 대화를 막을 이유가 없다.
 */
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

let asked = false;

async function allowed(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (asked || !current.canAskAgain) return false;
    asked = true;
    const asked_ = await Notifications.requestPermissionsAsync();
    return asked_.granted;
  } catch {
    return false;
  }
}

/** 지금 앱이 앞에 없으면 답변 도착을 알린다. */
export async function notifyAnswer(agentName: string, text: string): Promise<void> {
  if (AppState.currentState === 'active') return;
  if (!(await allowed())) return;
  const body = text.replace(/\s+/g, ' ').trim();
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: agentName || 'XGEN Dex',
        body: body.length > 140 ? `${body.slice(0, 140)}…` : body || '답변이 도착했습니다.',
      },
      trigger: null, // 즉시
    });
  } catch {
    /* 알림은 곁가지다 — 못 보내도 대화는 그대로다. */
  }
}
