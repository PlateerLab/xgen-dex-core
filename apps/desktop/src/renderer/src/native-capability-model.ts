import type { CapabilityCatalog, CapabilityApprovalPage } from '@dex/protocol/agent-capabilities';
import type { NativeCapabilitySnapshot } from '@dex/engine/native-capability-bridge';
import type { NativeRpcResult } from '@dex/rpc';
import type { DesktopNativeBridge, DesktopNativeMethod } from '../../native-session-types';

export interface DesktopCapabilityView {
  busy: boolean;
  catalog: CapabilityCatalog | null;
  authScope: string | null;
  selected: readonly string[];
  approvals: CapabilityApprovalPage['approvals'];
  connection: NativeCapabilitySnapshot | null;
  error: string;
  notice: string;
}
export function blankCapabilityView(): DesktopCapabilityView {
  return { busy: false, catalog: null, authScope: null, selected: [], approvals: [], connection: null, error: '', notice: '' };
}

/** Scoped main-process bridge owns all credentials and the actual one-use confirmation. */
export class DesktopCapabilityModel {
  state = blankCapabilityView();
  private generation = 0;
  private disposed = false;
  private readonly remove: () => void;
  constructor(private readonly bridge: DesktopNativeBridge, private readonly sessionId: string | null,
    private readonly render: (view: DesktopCapabilityView) => void) {
    this.remove = bridge.onUpdate((notice) => {
      if (this.disposed) return;
      if (notice.type === 'cleared') { this.generation++; this.state = blankCapabilityView(); this.publish(); return; }
      if ('view' in notice.value && notice.value.view === 'capabilities') {
        this.show({ connection: notice.value.snapshot });
      }
    });
  }
  private publish(): void { if (!this.disposed) this.render(this.state); }
  private show(patch: Partial<DesktopCapabilityView>): void { this.state = { ...this.state, ...patch }; this.publish(); }
  private async request(method: DesktopNativeMethod, params: Record<string, unknown> = {}): Promise<NativeRpcResult> {
    const reply = await this.bridge.request(method, params);
    if (!reply.ok) throw new Error(reply.message);
    if (!('user_id' in reply.value)) throw new Error('현재 기기의 응답을 확인할 수 없습니다.');
    return reply.value;
  }
  toggle(capabilityId: string): void {
    if (this.disposed || this.state.busy || !this.state.catalog?.capabilities.some((c) => c.capability_id === capabilityId)) return;
    this.show({ selected: this.state.selected.includes(capabilityId)
      ? this.state.selected.filter((id) => id !== capabilityId) : [...this.state.selected, capabilityId], notice: '' });
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.state.busy || !this.sessionId) return;
    const generation = this.generation;
    this.show({ busy: true, error: '', notice: '' });
    try {
      const value = await this.request('capabilities', { agent_session_id: this.sessionId });
      if (generation !== this.generation || this.disposed) return;
      const catalog = value.capability_catalog;
      if (!catalog || !('authScope' in catalog) || typeof catalog.authScope !== 'string') throw new Error('기기 선택 범위를 확인할 수 없습니다.');
      this.show({ catalog, authScope: catalog.authScope, selected: [...catalog.selected_capability_ids] });
      const result = await this.request('capability-approvals', { agent_session_id: this.sessionId, expected_auth_scope: catalog.authScope });
      if (generation !== this.generation || this.disposed) return;
      if (!result.capability_approvals) throw new Error('승인 목록을 확인할 수 없습니다.');
      this.show({ approvals: result.capability_approvals.approvals, notice: '현재 기기와 승인 상태를 확인했습니다.' });
    } catch (error) {
      if (generation === this.generation) this.show({ catalog: null, authScope: null, selected: [], approvals: [], error: safeMessage(error) });
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  async save(revoke = false): Promise<void> {
    const { catalog, authScope } = this.state;
    if (this.disposed || this.state.busy || !this.sessionId || !catalog || !authScope) return;
    const generation = this.generation;
    this.show({ busy: true, error: '', notice: '' });
    try {
      const value = await this.request('select-capabilities', { agent_session_id: this.sessionId,
        expected_auth_scope: authScope, capability_ids: revoke ? [] : [...this.state.selected], expected_version: catalog.version });
      if (generation !== this.generation || this.disposed) return;
      if (!value.capability_selection) throw new Error('기기 선택 완료 여부를 다시 확인하세요.');
      this.show({ catalog: null, authScope: null, selected: [], approvals: [],
        notice: revoke ? '이 대화의 기기 선택을 철회했습니다.' : '이 대화에 사용할 기기를 저장했습니다.' });
    } catch (error) {
      if (generation === this.generation) this.show({ catalog: null, authScope: null, selected: [], approvals: [], error: safeMessage(error) });
    } finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  async adopt(approvalId: number): Promise<void> {
    const approval = this.state.approvals.find((a) => a.approval_id === approvalId);
    if (this.disposed || this.state.busy || !this.sessionId || !this.state.authScope
      || !approval || approval.status !== 'approved' || approval.expires_at * 1000 <= Date.now()) return;
    const generation = this.generation;
    this.show({ busy: true, error: '', notice: '' });
    try {
      const result = await this.request('adopt-capability-approval', { agent_session_id: this.sessionId, approval_id: approvalId,
        expected_auth_scope: this.state.authScope, expected_version: approval.intent_version });
      if (generation !== this.generation || this.disposed) return;
      if (!result.capability_adoption) throw new Error('승인 연결 완료 여부를 다시 확인하세요.');
      this.show({ approvals: [], notice: '승인된 작업을 다음 턴에 연결했습니다. 같은 기기와 인자에 한 번만 사용할 수 있습니다.' });
    } catch (error) { if (generation === this.generation) this.show({ approvals: [], error: safeMessage(error) }); }
    finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  async connection(start: boolean): Promise<void> {
    if (this.disposed || (start && this.state.busy)) return;
    const generation = this.generation;
    this.show({ busy: true, error: '', notice: '' });
    try {
      const result = await this.request(start ? 'connect-capabilities' : 'disconnect-capabilities');
      if (generation !== this.generation || this.disposed) return;
      this.show({ connection: result.capability_connection ?? null });
    } catch (error) { if (generation === this.generation) this.show({ connection: null, error: safeMessage(error) }); }
    finally { if (generation === this.generation) this.show({ busy: false }); }
  }
  async confirm(allow: boolean): Promise<void> {
    const pending = this.state.connection?.confirmation;
    if (this.disposed || this.state.connection?.state !== 'confirmation_required' || !pending) return;
    const generation = this.generation;
    // Clear synchronously: repeated clicks cannot acknowledge the same request twice.
    this.show({ connection: null, error: '' });
    try {
      const result = await this.request('confirm-capability', { request_id: pending.requestId,
        confirmed: allow && pending.expiresAt * 1000 > Date.now() });
      if (generation === this.generation && !this.disposed) this.show({ connection: result.capability_connection ?? null });
    } catch (error) { if (generation === this.generation) this.show({ error: safeMessage(error) }); }
  }
  dispose(): void {
    this.disposed = true; this.generation++; this.remove(); this.state = blankCapabilityView();
    // Leaving the confirmation surface must not keep this device available unattended.
    void this.bridge.request('disconnect-capabilities').catch(() => {});
  }
}
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : '기기 작업을 완료하지 못했습니다. 상태를 다시 확인하세요.'; }
