#!/bin/bash

# Custom after-install: identical to electron-builder 25's default template
# EXCEPT the chrome-sandbox permission logic (see below). Keep the alternatives
# symlink + mime/desktop-database blocks in sync with the stock template when
# upgrading electron-builder.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# ALWAYS make chrome-sandbox SUID-root. The stock template probes user
# namespaces with `unshare --user` — but postinst runs as ROOT, for whom
# userns always works, while Ubuntu 23.10+/24.04 ships
# kernel.apparmor_restrict_unprivileged_userns=1 which blocks userns for the
# actual UNPRIVILEGED user at runtime. The stock probe therefore leaves the
# helper at 0755 and the app dies at launch with SIGTRAP
# ("SUID sandbox helper ... is not configured correctly"). The SUID helper
# path works on every kernel/AppArmor combination, so use it unconditionally.
# 결과를 **설치 로그에 남긴다.** 조용히 실패하면 나중에 앱이 SIGTRAP 으로
# 죽었을 때 원인 추적이 처음부터 다시 시작된다.
SANDBOX='/opt/${sanitizedProductName}/chrome-sandbox'
if chown root:root "$SANDBOX" 2>/dev/null && chmod 4755 "$SANDBOX" 2>/dev/null; then
    echo "xgen-dex: chrome-sandbox SUID-root 설정 완료 (샌드박스 사용)"
else
    echo "xgen-dex: chrome-sandbox SUID 설정 실패 — 앱이 --no-sandbox 로 자동 전환됩니다" >&2
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
