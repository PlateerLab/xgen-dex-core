/**
 * 비밀(제공자 API 키) — `<루트>/.xd/secrets/<계정 id>.bin`, Electron safeStorage 로 암호화.
 *
 * 네이티브 모듈(keytar)은 쓰지 않는다. safeStorage 를 쓸 수 없는 환경(리눅스에 키링이 없을 때)에서는 파일 권한
 * (0600)만으로 둔다 — 대신 {@link Secrets.status} 가 그 사실을 알려 화면이 말할 수 있게 한다(조용히 약하게 두지
 * 않는다). 파일 머리 한 줄이 어느 쪽인지 적는다: `enc1\n` + 암호문 | `raw1\n` + 평문.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretCrypto {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
  /** 리눅스에서 safeStorage 가 고른 저장소(`basic_text` 면 사실상 평문). 다른 OS 는 '' */
  backend(): string;
}

export interface SecretStatus {
  /** 암호화해 두는가 — false 면 파일 권한으로만 지킨다. */
  encrypted: boolean;
  backend: string;
}

const ENC = Buffer.from('enc1\n');
const RAW = Buffer.from('raw1\n');
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class Secrets {
  constructor(
    private readonly dir: string,
    private readonly crypto: SecretCrypto,
  ) {}

  status(): SecretStatus {
    const backend = this.crypto.backend();
    // 리눅스의 basic_text 는 암호화가 아니라 고정 키 난독화다 — 암호화한다고 말하지 않는다.
    return { encrypted: this.crypto.available() && backend !== 'basic_text', backend };
  }

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid secret id: ${id}`);
    return join(this.dir, `${id}.bin`);
  }

  set(id: string, value: string | null): void {
    const file = this.file(id);
    if (value === null || value === '') {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const body = this.status().encrypted
      ? Buffer.concat([ENC, this.crypto.encrypt(value)])
      : Buffer.concat([RAW, Buffer.from(value, 'utf8')]);
    writeFileSync(file, body, { mode: 0o600 });
  }

  get(id: string): string | null {
    const file = this.file(id);
    if (!existsSync(file)) return null;
    const body = readFileSync(file);
    if (body.subarray(0, ENC.length).equals(ENC)) {
      try {
        return this.crypto.decrypt(body.subarray(ENC.length));
      } catch {
        // 다른 PC·다른 사용자 계정에서 옮겨 온 루트 — 이 PC 의 키로는 풀 수 없다. 다시 입력받아야 한다.
        return null;
      }
    }
    if (body.subarray(0, RAW.length).equals(RAW)) return body.subarray(RAW.length).toString('utf8');
    return null;
  }

  has(id: string): boolean {
    return this.get(id) !== null;
  }
}
