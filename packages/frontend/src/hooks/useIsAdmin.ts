import { useContext } from 'react';
import { AuthContext } from 'react-oidc-context';
import { isAdmin } from '../lib/crmLaunch';

/**
 * Whether the signed-in user is in the Cognito group "admin". It only hides
 * admin screens: the API checks the role itself (app/caller.py). False
 * outside the sign-in provider (no user), without useAuth()'s warning.
 */
export function useIsAdmin(): boolean {
  return isAdmin(useContext(AuthContext)?.user?.profile);
}
