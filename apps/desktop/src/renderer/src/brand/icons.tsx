/** Minimal inline icon set (stroke = currentColor), Lucide-style, no deps. */
import React from 'react';

type P = { size?: number; className?: string };
const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export const EyeIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const EyeOffIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13 13 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13 13 0 0 0 1 12s4 7 11 7a9 9 0 0 0 5.39-1.61" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
export const SendIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
  </svg>
);
export const SettingsIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const RefreshIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);
export const PlusIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);
export const StopIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
export const ChatIcon: React.FC<P> = ({ size = 40, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  </svg>
);
export const LogoutIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
);
export const DocIcon: React.FC<P> = ({ size = 12, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </svg>
);
export const ServerIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>
);
export const PanelLeftIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
  </svg>
);
export const HistoryIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l4 2" />
  </svg>
);
/** 아바타 설정 (사이드바 헤더) — 사람 실루엣 원형. */
export const AvatarIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="10" r="3" />
    <path d="M6.2 18.9a6.5 6.5 0 0 1 11.6 0" />
  </svg>
);
export const BackIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </svg>
);
export const ElementSelectIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m4 3 7.5 17 2.1-6.4L20 11.5Z" />
    <path d="m14 14 5 5" />
  </svg>
);
export const RegionSelectIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);
export const PencilIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  </svg>
);
export const TrashIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);
export const UploadIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
export const MicIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);
export const MicOffIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
    <path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
    <path d="M19 10v2a7 7 0 0 1-.11 1.23" />
    <path d="M5 10v2a7 7 0 0 0 12 5" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);
export const HandsfreeIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M2 12h2" />
    <path d="M6 8v8" />
    <path d="M10 5v14" />
    <path d="M14 8v8" />
    <path d="M18 10v4" />
    <path d="M22 12h-2" />
  </svg>
);
export const SpeakerIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);
export const SpeakerOffIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
export const BotIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4" />
    <circle cx="12" cy="4" r="1" />
    <path d="M9 13h.01" />
    <path d="M15 13h.01" />
    <path d="M2 14v2" />
    <path d="M22 14v2" />
  </svg>
);

/** 화면 캡처 — 채팅에 화면을 함께 보낼 때의 표시. */
export const MonitorIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

/** 닫기 — 모달/패널 공용. */
export const CloseIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/** 복사 — 로그·코드처럼 다른 곳으로 옮겨 갈 내용에 붙는다. */
export const CopyIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

/** 탐색기(액티비티 바) — 겹친 문서 두 장, VS Code 의 Explorer 관용구. */
export const FilesIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6Z" />
    <path d="M15 2v4h4" />
    <path d="M5 8H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-1" />
  </svg>
);
export const FolderIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);
export const FolderOpenIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </svg>
);
/** 트리 펼침 셰브런 — 펼치면 CSS 로 90° 돌린다. */
export const ChevronRightIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);
/** 셀렉터 트리거 셰브런 — 열리면 CSS 로 180° 돌린다. */
export const ChevronDownIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
/** XgenCloud 섹션 — 클라우드 스토리지. */
export const CloudIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </svg>
);

/** Sandboxed agent browser page. */
export const BrowserIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </svg>
);

/** A website-requested popup that remains outside the managed tab runtime. */
export const PopupBlockedIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="m9 13 6 6M15 13l-6 6" />
  </svg>
);

export const ForwardIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m12 5 7 7-7 7" />
    <path d="M5 12h14" />
  </svg>
);

/** Teams — 사람 사이의 대화(사이드탭). 사람 둘이 겹친 Lucide 'users'. */
export const TeamsIcon: React.FC<P> = ({ size = 18, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

/** 대화 상대 초대 — 사람 + 더하기. */
export const UserPlusIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M19 8v6" />
    <path d="M22 11h-6" />
  </svg>
);

/** 이모지 리액션 — 웃는 얼굴. */
export const SmileIcon: React.FC<P> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="10" />
    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
    <path d="M9 9h.01" />
    <path d="M15 9h.01" />
  </svg>
);

/** 답장 — 되돌아가는 화살표(Lucide 'reply'). */
export const ReplyIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="m9 17-5-5 5-5" />
    <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
  </svg>
);

/** 파일 첨부 — 클립. */
export const PaperclipIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/** 내려받기 — 아래로 향한 화살표 + 받침. */
export const DownloadIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);

/** 다른 곳으로 공유 — 상자에서 위로 나가는 화살표(Lucide 'share'). */
export const ShareIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <path d="M16 6l-4-4-4 4" />
    <path d="M12 2v13" />
  </svg>
);

/** 더 보기 — 가로 점 셋. */
export const MoreIcon: React.FC<P> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
);

/** 알림 켜짐 — 종. */
export const BellIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

/** 알림 꺼짐 — 종에 사선. */
export const BellOffIcon: React.FC<P> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M8.7 3A6 6 0 0 1 18 8c0 2.4.4 4.2.9 5.5" />
    <path d="M17 17H3s3-2 3-9a6 6 0 0 1 .3-1.8" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <path d="m2 2 20 20" />
  </svg>
);
