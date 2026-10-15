import React from 'react';

/** XD 표식 — 앱 이름 두 글자. */
export const XdMark: React.FC<{ size?: number }> = ({ size = 28 }) => (
  <span className="xd-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-label="XD">
    XD
  </span>
);
