// Microsoft Entra ID sign-in (browser half): MSAL Browser v5, SPA
// authorization-code flow with PKCE, no client secret.
//
// MSAL only gets the user through Microsoft's login page and back. The ID token
// it returns is handed to the server, which verifies it (signature, issuer,
// audience, tenant, nonce, state) and issues the HttpOnly session cookie. MSAL's
// own cache is therefore wiped as soon as it has done that job.
import {
  PublicClientApplication,
  BrowserCacheLocation,
  type AuthenticationResult,
} from '@azure/msal-browser';

interface AuthConfig {
  clientId: string;
  authority: string;
  scopes: string[];
}

interface StartResponse {
  state: string;
  nonce: string;
}

interface SessionUser {
  username: string;
  role: string;
  last_login: string | null;
}

export interface RedirectOutcome {
  /** True when this page load completed a sign-in and the cookie is now set. */
  signedIn: boolean;
  /** Message to show on the login screen, if the attempt failed. */
  error?: string;
}

const CALLBACK_PATH = '/oauth2/callback';

let pca: PublicClientApplication | null = null;

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${String(res.status)})`);
  return data as T;
}

async function getConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/auth/config', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load sign-in configuration');
  return (await res.json()) as AuthConfig;
}

// Drops everything MSAL has persisted. A half-finished earlier attempt (closed
// tab, back button, expired transaction) leaves request state behind that makes
// the next redirect fail with interaction_in_progress.
function clearMsalStorage(): void {
  for (const store of [window.sessionStorage, window.localStorage]) {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && (key.startsWith('msal.') || key.includes('msal.') || key.startsWith('interaction.status'))) {
        stale.push(key);
      }
    }
    for (const key of stale) store.removeItem(key);
  }
}

async function getApp(): Promise<PublicClientApplication> {
  if (pca) return pca;
  const cfg = await getConfig();
  const app = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: cfg.authority,
      redirectUri: `${window.location.origin}${CALLBACK_PATH}`,
      postLogoutRedirectUri: window.location.origin,
    },
    // sessionStorage: nothing outlives the tab, and the token is discarded after
    // the server exchange anyway.
    cache: { cacheLocation: BrowserCacheLocation.SessionStorage },
  });
  await app.initialize();
  pca = app;
  return app;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function leaveCallbackUrl(): void {
  window.history.replaceState(null, document.title, '/');
}

/**
 * Call once on every page load, before asking the server who the user is.
 * On the callback URL it finishes the sign-in; anywhere else it is a no-op.
 */
export async function completeRedirect(): Promise<RedirectOutcome> {
  const onCallback = window.location.pathname === CALLBACK_PATH;
  if (!onCallback) return { signedIn: false };

  try {
    const app = await getApp();
    // navigateToLoginRequestUrl:false — stay on the callback page instead of
    // bouncing back to the page that started the login; we tidy the URL ourselves.
    const result: AuthenticationResult | null = await app.handleRedirectPromise({
      navigateToLoginRequestUrl: false,
    });
    if (!result || !result.idToken) {
      throw new Error('Sign-in did not complete. Please try again.');
    }
    if (!result.state) throw new Error('Sign-in response is missing state');

    // The server re-checks state and nonce against its signed transaction cookie
    // and verifies the token itself; nothing here is trusted.
    await postJson<SessionUser>('/api/auth/entra', { idToken: result.idToken, state: result.state });
    return { signedIn: true };
  } catch (err) {
    return { signedIn: false, error: messageOf(err) };
  } finally {
    clearMsalStorage();
    leaveCallbackUrl();
  }
}

/** Starts the Microsoft sign-in redirect. Resolves only if the redirect fails. */
export async function signIn(): Promise<void> {
  clearMsalStorage();
  pca = null;
  const app = await getApp();
  const { state, nonce } = await postJson<StartResponse>('/api/auth/start');
  await app.loginRedirect({
    scopes: ['openid', 'profile', 'email'],
    state,
    nonce,
    prompt: 'select_account',
  });
}

/** Local half of logout; the server session is ended by /api/logout. */
export function clearLocalAuthState(): void {
  pca = null;
  clearMsalStorage();
}

declare global {
  interface Window {
    entraAuth: {
      completeRedirect: typeof completeRedirect;
      signIn: typeof signIn;
      clearLocalAuthState: typeof clearLocalAuthState;
    };
  }
}

window.entraAuth = { completeRedirect, signIn, clearLocalAuthState };
