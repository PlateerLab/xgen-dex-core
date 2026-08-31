// 배포 프로필의 서버·인증·SSO·업데이트 기본값을 검증하고 구성한다
export interface DeploymentDefaultInput {
  serverUrl?: string;
  allowPrivateCertificate?: string;
  ssoEnabled?: string;
  ssoPath?: string;
  updateServer?: string;
}

export interface DeploymentDefaults {
  serverUrl?: string;
  allowPrivateCertificate?: boolean;
  ssoEnabled?: boolean;
  ssoPath?: string;
  updateServer?: 'github' | 'xgen';
}

function optionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name}은 true, false, 1, 0 중 하나여야 합니다.`);
}

export function resolveDeploymentDefaults(input: DeploymentDefaultInput): DeploymentDefaults {
  const defaults: DeploymentDefaults = {};

  if (input.serverUrl) {
    const serverUrl = input.serverUrl.trim().replace(/\/+$/, '');
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('기본 서버 URL은 http 또는 https URL이어야 합니다.');
    }
    defaults.serverUrl = serverUrl;
  }

  const allowPrivateCertificate = optionalBoolean(
    input.allowPrivateCertificate,
    'XGEN_DEFAULT_ALLOW_PRIVATE_CERTIFICATE',
  );
  if (allowPrivateCertificate !== undefined)
    defaults.allowPrivateCertificate = allowPrivateCertificate;

  const ssoEnabled = optionalBoolean(input.ssoEnabled, 'XGEN_DEFAULT_SSO_ENABLED');
  if (ssoEnabled !== undefined) defaults.ssoEnabled = ssoEnabled;

  if (input.ssoPath) {
    const ssoPath = input.ssoPath.trim();
    if (!ssoPath.startsWith('/') || ssoPath.startsWith('//')) {
      throw new Error('기본 SSO PATH는 /로 시작하는 상대 경로여야 합니다.');
    }
    defaults.ssoPath = ssoPath;
  }

  if (input.updateServer) {
    if (input.updateServer !== 'github' && input.updateServer !== 'xgen') {
      throw new Error('기본 업데이트 서버는 github 또는 xgen이어야 합니다.');
    }
    defaults.updateServer = input.updateServer;
  }

  return defaults;
}

export const DEPLOYMENT_DEFAULTS = resolveDeploymentDefaults({
  serverUrl: process.env.XGEN_DEFAULT_SERVER_URL,
  allowPrivateCertificate: process.env.XGEN_DEFAULT_ALLOW_PRIVATE_CERTIFICATE,
  ssoEnabled: process.env.XGEN_DEFAULT_SSO_ENABLED,
  ssoPath: process.env.XGEN_DEFAULT_SSO_PATH,
  updateServer: process.env.XGEN_DEFAULT_UPDATE_SERVER,
});
