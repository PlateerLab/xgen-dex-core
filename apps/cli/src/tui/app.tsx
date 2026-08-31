import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { DexError, publicError } from '../errors';
import type { ProfileSummary } from '../engine';
import { Dashboard } from './dashboard';
import { Footer, Header, Loading, Notice } from './components';
import { LoginScreen } from './login-screen';
import type { TuiEngine, TuiSession } from './model';
import { ProfileScreen } from './profile-screen';
import { SetupScreen } from './setup-screen';

type Route = 'boot' | 'setup' | 'login' | 'dashboard' | 'profiles' | 'fatal';

export function App({ engine }: { engine: TuiEngine }): React.ReactNode {
  const { exit } = useApp();
  const [route, setRoute] = useState<Route>('boot');
  const [session, setSession] = useState<TuiSession>();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [loginTarget, setLoginTarget] = useState<{ profile: string; serverUrl: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useInput((input, key) => {
    if (key.ctrl && input === 'q') exit();
  });

  const bootstrap = useCallback(
    async (preferredProfile?: string): Promise<void> => {
      setRoute('boot');
      setBusy(true);
      setError(undefined);
      try {
        let available = await engine.listProfiles();
        setProfiles(available);
        if (available.length === 0) {
          setSession(undefined);
          setRoute('setup');
          return;
        }
        if (preferredProfile) {
          await engine.useProfile(preferredProfile);
          available = await engine.listProfiles();
          setProfiles(available);
        }
        const current =
          available.find((profile) => profile.current) ??
          available.find((profile) => profile.name === preferredProfile) ??
          available[0];
        if (!current) throw new DexError('config_invalid', '사용할 프로필이 없습니다.');
        const status = await engine.authStatus(current.name);
        if (!status.authenticated) {
          if (status.reason === 'network') {
            throw new DexError('network_error', `XGEN 서버에 연결할 수 없습니다: ${current.serverUrl}`);
          }
          setSession(undefined);
          setLoginTarget({ profile: current.name, serverUrl: current.serverUrl });
          setRoute('login');
          return;
        }
        const agents = await engine.listAgents({ pageSize: 100, includeHarness: true }, current.name);
        setSession({
          profile: current.name,
          serverUrl: current.serverUrl,
          username: status.user?.username ?? 'unknown',
          agents: agents.items,
        });
        setRoute('dashboard');
      } catch (reason) {
        setError(publicError(reason).message);
        setRoute('fatal');
      } finally {
        setBusy(false);
      }
    },
    [engine],
  );

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const configure = async (serverUrl: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const profile = await engine.setProfile('default', serverUrl);
      await engine.useProfile(profile.name);
      setLoginTarget({ profile: profile.name, serverUrl: profile.serverUrl });
      setProfiles(await engine.listProfiles());
      setRoute('login');
    } catch (reason) {
      setError(publicError(reason).message);
    } finally {
      setBusy(false);
    }
  };

  const login = async (email: string, password: string): Promise<void> => {
    if (!loginTarget) return;
    setBusy(true);
    setError(undefined);
    try {
      await engine.login(email, password, loginTarget.profile);
      await bootstrap(loginTarget.profile);
    } catch (reason) {
      setError(publicError(reason).message);
      setRoute('login');
    } finally {
      setBusy(false);
    }
  };

  const openProfiles = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      setProfiles(await engine.listProfiles());
      setRoute('profiles');
    } catch (reason) {
      setError(publicError(reason).message);
    } finally {
      setBusy(false);
    }
  };

  const createProfile = async (name: string, serverUrl: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await engine.setProfile(name, serverUrl);
      await bootstrap(name);
    } catch (reason) {
      setError(publicError(reason).message);
      setRoute('profiles');
    } finally {
      setBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    if (!session) return;
    setBusy(true);
    try {
      await engine.logout(session.profile);
      setLoginTarget({ profile: session.profile, serverUrl: session.serverUrl });
      setSession(undefined);
      setRoute('login');
    } catch (reason) {
      setError(publicError(reason).message);
      setRoute('fatal');
    } finally {
      setBusy(false);
    }
  };

  if (route === 'boot') {
    return (
      <Box flexDirection="column">
        <Header />
        <Loading label="Dex를 준비하는 중..." />
        <Footer text="Ctrl+Q 종료" />
      </Box>
    );
  }
  if (route === 'setup') {
    return <SetupScreen busy={busy} error={error} onSubmit={(url) => void configure(url)} />;
  }
  if (route === 'login' && loginTarget) {
    return (
      <LoginScreen
        profile={loginTarget.profile}
        serverUrl={loginTarget.serverUrl}
        busy={busy}
        error={error}
        onSubmit={(email, password) => void login(email, password)}
        onProfiles={() => void openProfiles()}
      />
    );
  }
  if (route === 'profiles') {
    return (
      <ProfileScreen
        profiles={profiles}
        busy={busy}
        error={error}
        onSelect={(name) => void bootstrap(name)}
        onCreate={(name, url) => void createProfile(name, url)}
        onCancel={() => setRoute(session ? 'dashboard' : loginTarget ? 'login' : 'setup')}
      />
    );
  }
  if (route === 'dashboard' && session) {
    return (
      <Dashboard
        engine={engine}
        session={session}
        onProfiles={() => void openProfiles()}
        onLogout={() => void logout()}
      />
    );
  }
  return (
    <Box flexDirection="column">
      <Header />
      <Notice error>{error ?? '알 수 없는 오류가 발생했습니다.'}</Notice>
      <Text dimColor>서버와 키체인 상태를 확인한 뒤 다시 시도하세요.</Text>
      <Footer text="R 다시 시도 · Ctrl+Q 종료" />
      <RetryInput onRetry={() => void bootstrap()} />
    </Box>
  );
}

function RetryInput({ onRetry }: { onRetry: () => void }): null {
  useInput((input) => {
    if (input.toLowerCase() === 'r') onRetry();
  });
  return null;
}
