import { ApiError } from '@dex/protocol/client';

export type DexErrorCode =
  | 'auth_required'
  | 'auth_invalid'
  | 'config_invalid'
  | 'credential_store_unavailable'
  | 'local_command_denied'
  | 'local_open_denied'
  | 'local_path_denied'
  | 'local_tool_failed'
  | 'local_tools_disabled'
  | 'network_error'
  | 'not_found'
  | 'protocol_mismatch'
  | 'usage_error';

export class DexError extends Error {
  constructor(
    readonly code: DexErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DexError';
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function publicError(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof DexError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof ApiError) {
    return {
      code: `http_${error.status}`,
      message: error.message,
      details: error.body,
    };
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return { code: 'cancelled', message: '요청이 취소되었습니다.' };
    return { code: 'internal_error', message: error.message };
  }
  return { code: 'internal_error', message: String(error) };
}
