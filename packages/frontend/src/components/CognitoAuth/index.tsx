import React, { PropsWithChildren, useEffect } from 'react';
import { AuthProvider, AuthProviderProps, useAuth } from 'react-oidc-context';
import { Alert } from '../Alert';
import CubeLoader from '../CubeLoader';
import { useRuntimeConfig } from '../../hooks/useRuntimeConfig';
import { launchReturnTo, safeLaunchReturn } from '../../lib/crmLaunch';

/**
 * Sets up the Cognito auth.
 *
 * This assumes a runtime-config.json file is present at '/'. In order for Auth to be set up automatically,
 * the runtime-config.json must have the cognitoProps set.
 */
const CognitoAuth: React.FC<PropsWithChildren> = ({ children }) => {
  const { cognitoProps } = useRuntimeConfig();

  if (!cognitoProps) {
    if (import.meta.env.MODE === 'serve-local') {
      // In serve-local mode with no cognitoProps available, we skip login
      return <AuthProvider>{children}</AuthProvider>;
    }
    return (
      <Alert type="error" header="Runtime config configuration error">
        <p>
          The cognitoProps have not been configured in the runtime-config.json.
        </p>
      </Alert>
    );
  }

  const cognitoAuthConfig: AuthProviderProps = {
    authority: `https://cognito-idp.${cognitoProps.region}.amazonaws.com/${cognitoProps.userPoolId}`,
    client_id: cognitoProps.userPoolWebClientId,
    redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'email openid profile',
    onSigninCallback: (user) => {
      // Signed in from a CRM launch link: reload on that link (the router
      // already read the callback URL), so /launch can verify it.
      const returnTo = safeLaunchReturn(user?.state);
      if (returnTo) {
        window.location.replace(returnTo);
        return;
      }
      // Remove OIDC callback params from URL and clean up stale state in localStorage
      window.history.replaceState({}, document.title, window.location.pathname);
    },
  };

  return (
    <AuthProvider {...cognitoAuthConfig}>
      <CognitoAuthInternal>{children}</CognitoAuthInternal>
    </AuthProvider>
  );
};

/** OIDC state of a sign-in: come back to a CRM launch link afterwards. */
function signinState(): { returnTo: string } | undefined {
  const returnTo = launchReturnTo(
    window.location.pathname,
    window.location.hash,
  );
  return returnTo ? { returnTo } : undefined;
}

// The effects depend on the auth fields they read, never on the whole `auth` object:
// it is new after every dispatch, and removeUser()/signinRedirect() dispatch, so effects
// keyed on it re-ran on their own and spun (hundreds of passes a second, the login page
// never committed) whenever a token refresh failed.
const CognitoAuthInternal: React.FC<PropsWithChildren> = ({ children }) => {
  const auth = useAuth();
  const {
    isAuthenticated,
    isLoading,
    activeNavigator,
    error,
    removeUser,
    signinRedirect,
  } = auth;
  // A failed redirect (offline, Cognito unreachable) is shown, not retried in a loop.
  const redirectFailed = error?.source === 'signinRedirect';

  // Once per auth error (e.g. token refresh failure): drop the stale user. The error
  // object keeps its identity through the dispatches removeUser() causes.
  useEffect(() => {
    if (!error || redirectFailed) return;
    console.error('Auth error:', error);
    void removeUser();
  }, [error, redirectFailed, removeUser]);

  // Signed out and idle: start one sign-in redirect.
  useEffect(() => {
    if (isAuthenticated || isLoading || activeNavigator || redirectFailed) return;
    void signinRedirect({ state: signinState() });
  }, [isAuthenticated, isLoading, activeNavigator, redirectFailed, signinRedirect]);

  // After a failed redirect, try once more when the network comes back.
  useEffect(() => {
    if (!redirectFailed) return;
    const retry = () => void signinRedirect({ state: signinState() });
    window.addEventListener('online', retry, { once: true });
    return () => window.removeEventListener('online', retry);
  }, [redirectFailed, signinRedirect]);

  if (isAuthenticated) {
    return children;
  }

  if (redirectFailed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-50 p-6 dark:bg-slate-900">
        <Alert type="error" header="Could not reach the sign-in page">
          <p>Check the internet connection, then try again.</p>
          <button
            type="button"
            className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            onClick={() => void signinRedirect({ state: signinState() })}
          >
            Try again
          </button>
        </Alert>
      </div>
    );
  }

  // Show loader while redirecting (including error redirect)
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-slate-50 dark:bg-slate-900">
      <CubeLoader />
    </div>
  );
};

export default CognitoAuth;
