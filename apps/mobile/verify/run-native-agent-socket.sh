#!/usr/bin/env bash
set -euo pipefail
# Run from apps/mobile on macOS. The CA injection exists only in the test compilation.
taskFixtureDir="$(mktemp -d)"
taskFixturePid=""
cleanup() {
  if [ -n "$taskFixturePid" ]; then
    kill "$taskFixturePid" 2>/dev/null || true
    wait "$taskFixturePid" 2>/dev/null || true
  fi
  rm -rf "$taskFixtureDir"
}
trap cleanup EXIT
cat > "$taskFixtureDir/cert.cnf" <<'CONFIG'
[req]
distinguished_name=subject
x509_extensions=extensions
prompt=no
[subject]
CN=localhost
[extensions]
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
CONFIG
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$taskFixtureDir/cert.cnf" \
  -keyout "$taskFixtureDir/key.pem" -out "$taskFixtureDir/cert.pem" 2> "$taskFixtureDir/certificate.log"
openssl x509 -in "$taskFixtureDir/cert.pem" -outform DER -out "$taskFixtureDir/cert.der"
node verify/native-agent-socket-fixture.mjs 39444 "$taskFixtureDir/cert.pem" "$taskFixtureDir/key.pem" \
  > "$taskFixtureDir/server.log" 2>&1 &
taskFixturePid=$!
for attempt in {1..50}; do
  if /usr/bin/grep -q '^ready$' "$taskFixtureDir/server.log"; then break; fi
  sleep 0.1
done
/usr/bin/grep -q '^ready$' "$taskFixtureDir/server.log"
xcrun swiftc -module-cache-path /tmp/cross-sync-swift-module-cache -D NATIVE_AGENT_SOCKET_TESTING \
  modules/xgen-native-device/ios/NativeAgentSocket.swift verify/native-agent-socket.swift \
  -o "$taskFixtureDir/verify"
"$taskFixtureDir/verify" https://localhost:39444 "$taskFixtureDir/cert.der"
kill "$taskFixturePid"
if ! wait "$taskFixturePid"; then
  /bin/cat "$taskFixtureDir/server.log" >&2
  exit 1
fi
taskFixturePid=""
