; XD 의 NSIS 추가 — 제거·업데이트 때 **설치 폴더(= XD 루트)의 사용자 데이터는 남긴다**.
;
; Windows 에서는 설치 폴더가 곧 XD 의 루트 폴더다(그 안에 workspace\ 와 .xd\ 가 생긴다). electron-builder 의 기본
; 제거는 설치 폴더를 통째로 지우므로(RMDir /r $INSTDIR), 앱을 지우거나 새 판으로 바꿀 때 에이전트의 작업 공간과
; 대화·키가 함께 사라진다. 앱이 깐 것만 지우고 workspace·.xd 는 건너뛴다. 다시 같은 곳에 설치하면 그대로 이어진다.
!macro customRemoveFiles
  FindFirst $0 $1 "$INSTDIR\*.*"
  xd_rm_loop:
    StrCmp $1 "" xd_rm_done
    StrCmp $1 "." xd_rm_next
    StrCmp $1 ".." xd_rm_next
    StrCmp $1 "workspace" xd_rm_next
    StrCmp $1 ".xd" xd_rm_next
    IfFileExists "$INSTDIR\$1\*.*" 0 xd_rm_file
      RMDir /r "$INSTDIR\$1"
      Goto xd_rm_next
    xd_rm_file:
      Delete "$INSTDIR\$1"
    xd_rm_next:
    FindNext $0 $1
    Goto xd_rm_loop
  xd_rm_done:
  FindClose $0
!macroend
