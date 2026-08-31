/**
 * SettingsSection — 설정 탭 공통 분류 단위.
 *
 * 모든 설정 탭은 항목을 이 컴포넌트로 묶는다: 대문자 소제목 + 테두리 카드(body)
 * 안에 field-row 들이 모인다. 제목/간격/테두리의 결이 여기(와 styles.css 의
 * .settings-group*) 한 곳에서 관리되므로 탭마다 분류 디자인이 갈라지지 않는다.
 *
 * `plain` — 자체 카드 UI(tool-card 등)를 가진 내용은 카드를 이중으로 씌우지
 * 않고 제목만 통일한다(브라우저/PC 컨트롤/MCP/스토리지).
 */
import React from 'react';

export const SettingsSection: React.FC<{
  title: string;
  plain?: boolean;
  children: React.ReactNode;
}> = ({ title, plain, children }) => (
  <section className="settings-group">
    <h3 className="settings-group-title">{title}</h3>
    {plain ? children : <div className="settings-group-body">{children}</div>}
  </section>
);
