; XD 의 NSIS 추가 — Windows 에서는 **설치 폴더가 곧 XD 루트**다(그 안에 workspace\ 와 .xd\ 가 생긴다).
;
; electron-builder 의 기본 제거는 설치 폴더를 통째로 지운다(RMDir /r $INSTDIR) — 앱을 지우거나 새 판으로 바꿀 때 작업
; 공간과 대화·키가 함께 사라진다. 대신 **이 설치본이 실제로 깐 것만** 지운다(목록은 scripts/after-pack.cjs 가 설치본마다
; 만든다). 다시 같은 곳에 설치하면 그대로 이어진다.

; 이 설치본이 까는 것의 목록(xdRemoveAppFiles).
!include "${__FILEDIR__}\xd-app-files.nsh"

!macro customRemoveFiles
  ; 엔진이 아직 돌면(파일이 잠겨) 지우다 말아 옛 판과 새 판이 섞인다 — 그 전에 멈춘다(업데이트는 다시 시도할 수 있다).
  IfFileExists "$INSTDIR\resources\engine\python\python.exe" 0 xd_probe_done
    ClearErrors
    Rename "$INSTDIR\resources\engine\python\python.exe" "$INSTDIR\resources\engine\python\python.exe.xd-busy"
    IfErrors 0 xd_probe_free
      SetErrorLevel 2
      Abort "XD 가 아직 돌고 있어 바꿀 수 없습니다."
    xd_probe_free:
    Rename "$INSTDIR\resources\engine\python\python.exe.xd-busy" "$INSTDIR\resources\engine\python\python.exe"
  xd_probe_done:
  !insertmacro xdRemoveAppFiles
!macroend

; 설치 폴더 고르기 — electron-builder 는 고른 경로에 "XD" 가 들어 있으면 \XD 를 붙이지 않는다(대소문자 무시). 그런데
; 사용자 이름처럼 우연히 "xd" 가 든 경로(C:\Users\alexd\Documents)라면 그 폴더에 바로 깔리고 그 폴더가 루트가 된다.
; 그런 경로에서는 비어 있거나 이미 XD 설치·XD 루트인 폴더만 받는다. (제거 프로그램을 만드는 단계에는 필요 없다.)
!ifndef BUILD_UNINSTALLER
Function .onVerifyInstDir
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrLen $R1 "$INSTDIR"
  StrCpy $R0 0
  xd_vid_scan:
    IntCmp $R0 $R1 xd_vid_ok xd_vid_ok
    StrCpy $R2 "$INSTDIR" 2 $R0
    StrCmp $R2 "XD" xd_vid_has
    IntOp $R0 $R0 + 1
    Goto xd_vid_scan
  xd_vid_has:
    IfFileExists "$INSTDIR\*.*" 0 xd_vid_ok
    IfFileExists "$INSTDIR\XD.exe" xd_vid_ok
    IfFileExists "$INSTDIR\.xd\*.*" xd_vid_ok
    FindFirst $R3 $R4 "$INSTDIR\*.*"
    xd_vid_entry:
      StrCmp $R4 "" xd_vid_empty
      StrCmp $R4 "." xd_vid_next
      StrCmp $R4 ".." xd_vid_next
      FindClose $R3
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
      Abort
      xd_vid_next:
      FindNext $R3 $R4
      Goto xd_vid_entry
    xd_vid_empty:
    FindClose $R3
  xd_vid_ok:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!endif
