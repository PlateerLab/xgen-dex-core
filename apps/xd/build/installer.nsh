; XD 의 NSIS 추가 — Windows 에서는 **설치 폴더가 곧 XD 루트**다(그 안에 workspace\ 와 .xd\ 가 생긴다).
;
; electron-builder 의 기본 제거는 설치 폴더를 통째로 지운다(RMDir /r $INSTDIR) — 앱을 지우거나 새 판으로 바꿀 때 작업
; 공간과 대화·키가 함께 사라진다. 대신 **이 설치본이 실제로 깐 것만** 지운다(목록은 scripts/after-pack.cjs 가 설치본마다
; 만든다). 다시 같은 곳에 설치하면 그대로 이어진다.

; 이 설치본이 까는 것의 목록(xdRemoveAppFiles).
!include "${__FILEDIR__}\xd-app-files.nsh"

!macro customRemoveFiles
  ; 엔진(또는 그 동봉 Python 으로 돈 MCP 서버)이 아직 돌면 파일이 잠겨 지우다 만다 — 옛 판과 새 판이 섞인다. 그 전에
  ; 멈춘다(업데이트는 실패로 끝나고 옛 판은 그대로, 다시 시도하면 된다). 실행 중인 exe 는 이름은 바뀌어도 쓰기로는
  ; 열리지 않으므로 쓰기로 열어 본다(내용은 건드리지 않는다).
  IfFileExists "$INSTDIR\resources\engine\python\python.exe" 0 xd_probe_done
    ClearErrors
    FileOpen $R9 "$INSTDIR\resources\engine\python\python.exe" a
    IfErrors 0 xd_probe_free
      SetErrorLevel 2
      Abort "XD 가 아직 돌고 있어 바꿀 수 없습니다."
    xd_probe_free:
    FileClose $R9
  xd_probe_done:
  !insertmacro xdRemoveAppFiles
!macroend

; 설치 폴더 고르기 — electron-builder 는 고른 경로에 "XD" 가 없을 때만 \XD 를 붙인다(대소문자 무시, instFilesPre).
; 사용자 이름처럼 우연히 "xd" 가 든 경로(C:\Users\alexd\Projects)라면 그 폴더에 바로 깔리고, 그 사람의 폴더가 루트가
; 되며 제거·업데이트가 그 안의 같은 이름(resources·locales 등)을 지운다. 그런 경로가 비어 있지 않고 XD 의 것(설치본·
; 루트)도 아니면 똑같이 \XD 를 붙인다. 보이지 않는 페이지 — 폴더 페이지 다음, 설치 직전에 돈다. (함수도 매크로 안에 —
; electron-builder 가 StrContains 를 들인 뒤인 페이지 자리에서 펼쳐진다.)
!macro customPageAfterChangeDir
Page custom xdInstDirPre
Function xdInstDirPre
  Push $R0
  Push $R1
  Push $R2
  ${StrContains} $R0 "${APP_FILENAME}" "$INSTDIR"
  StrCmp $R0 "" xd_dir_done
  IfFileExists "$INSTDIR\*.*" 0 xd_dir_done
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" xd_dir_done
  IfFileExists "$INSTDIR\.xd\*.*" xd_dir_done
  IfFileExists "$INSTDIR\workspace\*.*" xd_dir_done
  FindFirst $R1 $R2 "$INSTDIR\*.*"
  xd_dir_entry:
    StrCmp $R2 "" xd_dir_empty
    StrCmp $R2 "." xd_dir_next
    StrCmp $R2 ".." xd_dir_next
    ; 비어 있지 않은 남의 폴더 — 그 안에 XD 폴더를 만든다.
    FindClose $R1
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    Goto xd_dir_done
    xd_dir_next:
    FindNext $R1 $R2
    Goto xd_dir_entry
  xd_dir_empty:
  FindClose $R1
  xd_dir_done:
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd
!macroend
