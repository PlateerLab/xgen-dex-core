// 서버별 인증서 예외를 안전하게 검증하는 Node 연결 보안 도우미
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

// 기존 Node 소비자의 공개 경로는 유지한다. 브라우저 번들은 Node TLS 모듈을
// 따라오지 않도록 반드시 `connection-sso`를 직접 import한다.
export { buildSsoUrl, parseSsoLoginResponse } from './connection-sso';

const PRIVATE_CA_ERROR = 'CERT_AUTHORITY_INVALID';

export interface XgenServerTrust {
  /** Exact configured server origin this trust record applies to. */
  origin: string;
  /** PEM encoded private CA certificates. Hostname and validity checks stay enabled. */
  ca?: string[];
  /** SHA-256 certificate fingerprints accepted in addition to normal CA validation. */
  certificateSha256?: string[];
  /** Trust-change approval expiry in epoch milliseconds. */
  expiresAt: number;
}

function normalizedFingerprint(value: string): string {
  return value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

function serverOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  return url.origin;
}

function trustFor(serverUrl: string, records?: readonly XgenServerTrust[]): XgenServerTrust | undefined {
  let origin: string;
  try {
    origin = serverOrigin(serverUrl);
  } catch {
    return undefined;
  }
  return records?.find((record) => {
    try {
      return serverOrigin(record.origin) === origin && record.expiresAt > Date.now();
    } catch {
      return false;
    }
  });
}

function certificateErrorName(result: string): string {
  return result.replace(/^net::/, '').replace(/^ERR_/, '');
}

function certificateHostnameMatches(certificate: X509Certificate, hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return isIP(unwrapped) ? certificate.checkIP(unwrapped) !== undefined : certificate.checkHost(unwrapped) !== undefined;
}

function certificateTimeIsValid(
  certificate: X509Certificate,
  validStartSeconds?: number,
  validExpirySeconds?: number,
): boolean {
  const now = Date.now();
  // Electron Certificate.validStart/validExpiry are epoch seconds, while JS
  // dates use milliseconds. Check both Electron's fields and the signed PEM.
  if (validStartSeconds !== undefined && validStartSeconds * 1_000 > now) return false;
  if (validExpirySeconds !== undefined && validExpirySeconds * 1_000 <= now) return false;
  const pemStart = Date.parse(certificate.validFrom);
  const pemExpiry = Date.parse(certificate.validTo);
  return Number.isFinite(pemStart) && Number.isFinite(pemExpiry) && pemStart <= now && pemExpiry > now;
}

/** Electron의 full request URL과 PEM을 사용해 사설 CA 오류만 제한적으로 허용한다. */
export function shouldAllowPrivateCertificate(
  requestUrl: string,
  records: readonly XgenServerTrust[] | boolean | undefined,
  verificationResult: string,
  certificatePem?: string,
  certificateValidStartSeconds?: number,
  certificateValidExpirySeconds?: number,
): boolean {
  // Legacy boolean broad trust is deliberately never honored.
  if (!Array.isArray(records)) return false;
  const trust = trustFor(requestUrl, records);
  if (!trust || certificateErrorName(verificationResult) !== PRIVATE_CA_ERROR) return false;
  if (!certificatePem || !trust.certificateSha256?.length) return false;
  try {
    const requested = new URL(requestUrl);
    const certificate = new X509Certificate(certificatePem);
    if (!certificateTimeIsValid(
      certificate,
      certificateValidStartSeconds,
      certificateValidExpirySeconds,
    )) return false;
    if (!certificateHostnameMatches(certificate, requested.hostname)) return false;
    const fingerprint = normalizedFingerprint(certificate.fingerprint256);
    return trust.certificateSha256.some(
      (pin) => normalizedFingerprint(pin) === fingerprint,
    );
  } catch {
    return false;
  }
}

/** 설정된 XGEN Node WebSocket에 적용할 TLS 검증 옵션을 만든다. */
export function xgenWebSocketTlsOptions(
  serverUrl: string,
  records?: readonly XgenServerTrust[],
): {
  rejectUnauthorized: true;
  ca?: string[];
  checkServerIdentity?: (hostname: string, cert: PeerCertificate) => Error | undefined;
} {
  const trust = trustFor(serverUrl, records);
  if (!trust) return { rejectUnauthorized: true };
  const pins = (trust.certificateSha256 ?? []).map(normalizedFingerprint).filter(Boolean);
  return {
    rejectUnauthorized: true,
    ...(trust.ca?.length ? { ca: [...trust.ca] } : {}),
    ...(pins.length
      ? {
          checkServerIdentity(hostname: string, cert: PeerCertificate): Error | undefined {
            const standardError = checkServerIdentity(hostname, cert);
            if (standardError) return standardError;
            const fingerprint = normalizedFingerprint(cert.fingerprint256 ?? '');
            return pins.includes(fingerprint)
              ? undefined
              : new Error('XGEN server certificate pin mismatch');
          },
        }
      : {}),
  };
}
