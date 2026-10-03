import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, UserPlus, Users } from 'lucide-react';
import {
  ROLES,
  describeUsersError,
  displayName,
  inviteProblem,
  isRole,
  parsePoolUser,
  parsePoolUserList,
  type InviteInput,
  type PoolUser,
  type Role,
  type UserAction,
} from '../lib/adminUsers';

const SECTION_CLASS =
  'space-y-3 rounded-xl border border-black/[0.08] bg-white/30 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]';
const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-slate-200 dark:hover:bg-white/10';
const DANGER_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50';
const PRIMARY_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';
const INPUT_CLASS =
  'w-full rounded-lg border border-black/10 bg-white/70 px-2.5 py-1.5 text-sm text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-white/15 dark:bg-white/5 dark:text-slate-100';

export interface PendingAction {
  username: string;
  action: UserAction;
}

export interface AdminUsersTableProps {
  users: PoolUser[];
  /** The signed-in admin: no disable or role change on their own row. */
  currentUsername: string;
  busyUser: string | null;
  confirming: PendingAction | null;
  onAsk: (pending: PendingAction) => void;
  onCancel: () => void;
  onConfirm: (pending: PendingAction) => void;
  onRole: (user: PoolUser, role: Role) => void;
}

/** The pool's users with their role, status and actions. */
export function AdminUsersTable({
  users,
  currentUsername,
  busyUser,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
  onRole,
}: AdminUsersTableProps) {
  const { t } = useTranslation();
  if (users.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        {t('adminUsers.empty')}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="admin-users">
        <caption className="sr-only">{t('adminUsers.title')}</caption>
        <thead className="text-xs text-[var(--color-text-muted)]">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('adminUsers.user')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('adminUsers.role')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('adminUsers.status')}
            </th>
            <th scope="col" className="py-2 font-medium">
              {t('adminUsers.actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const self =
              user.username.toLowerCase() === currentUsername.toLowerCase();
            const busy = busyUser === user.username;
            const pending =
              confirming?.username === user.username ? confirming : null;
            const name = displayName(user);
            return (
              <tr
                key={user.username}
                className="border-t border-black/[0.06] align-top dark:border-white/[0.06]"
              >
                <td className="py-2 pr-3">
                  <div className="font-medium text-slate-800 dark:text-slate-100">
                    {name || user.username}
                    {self && (
                      <span className="ml-1 text-xs text-[var(--color-text-muted)]">
                        {t('adminUsers.you')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {user.username}
                    {user.email ? ` · ${user.email}` : ''}
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <select
                    aria-label={t('adminUsers.roleOf', {
                      user: user.username,
                    })}
                    className={INPUT_CLASS}
                    value={user.role ?? ''}
                    disabled={self || busy}
                    title={self ? t('adminUsers.ownRole') : undefined}
                    onChange={(e) => {
                      if (isRole(e.target.value)) onRole(user, e.target.value);
                    }}
                  >
                    {user.role === null && (
                      <option value="">{t('adminUsers.noRole')}</option>
                    )}
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(`adminUsers.roles.${role}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-3 text-xs">
                  <span
                    className={`rounded-full px-2 py-0.5 font-semibold ${
                      user.enabled
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-slate-200 text-slate-600 dark:bg-white/10 dark:text-slate-300'
                    }`}
                  >
                    {user.enabled
                      ? t('adminUsers.enabled')
                      : t('adminUsers.disabled')}
                  </span>
                  {user.status === 'FORCE_CHANGE_PASSWORD' && (
                    <div className="mt-1 text-[var(--color-text-muted)]">
                      {t('adminUsers.invited')}
                    </div>
                  )}
                </td>
                <td className="py-2">
                  {pending ? (
                    <div
                      role="alertdialog"
                      aria-label={t(`adminUsers.confirm.${pending.action}`, {
                        user: user.username,
                      })}
                      className="space-y-1.5"
                    >
                      <p className="text-xs text-slate-700 dark:text-slate-200">
                        {t(`adminUsers.confirm.${pending.action}`, {
                          user: user.username,
                        })}
                      </p>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          className={DANGER_CLASS}
                          disabled={busy}
                          onClick={() => onConfirm(pending)}
                        >
                          {busy && (
                            <Loader2
                              className="h-3 w-3 animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          {t('adminUsers.yes')}
                        </button>
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={onCancel}
                        >
                          {t('adminUsers.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {user.enabled ? (
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          disabled={self || busy}
                          title={self ? t('adminUsers.ownDisable') : undefined}
                          onClick={() =>
                            onAsk({
                              username: user.username,
                              action: 'disable',
                            })
                          }
                        >
                          {t('adminUsers.disable')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          disabled={busy}
                          onClick={() =>
                            onConfirm({
                              username: user.username,
                              action: 'enable',
                            })
                          }
                        >
                          {t('adminUsers.enable')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        disabled={busy || !user.enabled}
                        onClick={() =>
                          onAsk({ username: user.username, action: 'reset' })
                        }
                      >
                        {user.status === 'FORCE_CHANGE_PASSWORD'
                          ? t('adminUsers.resendInvite')
                          : t('adminUsers.resetPassword')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface InviteUserFormProps {
  busy: boolean;
  error: string | null;
  onInvite: (input: InviteInput) => Promise<boolean>;
}

const EMPTY_INVITE: InviteInput = {
  email: '',
  given_name: '',
  family_name: '',
  role: 'handler',
};

/** Invite a user: Cognito emails the username and a temporary password. */
export function InviteUserForm({ busy, error, onInvite }: InviteUserFormProps) {
  const { t } = useTranslation();
  const id = useId();
  const [input, setInput] = useState<InviteInput>(EMPTY_INVITE);
  const [problem, setProblem] = useState<'email' | 'name' | null>(null);

  const set = (key: keyof InviteInput) => (value: string) =>
    setInput((prev) => ({ ...prev, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = inviteProblem(input);
    setProblem(found);
    if (found) return;
    if (await onInvite({ ...input, email: input.email.trim() })) {
      setInput(EMPTY_INVITE);
    }
  };

  const field = (
    key: 'email' | 'given_name' | 'family_name',
    type = 'text',
  ) => (
    <div>
      <label
        htmlFor={`${id}-${key}`}
        className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
      >
        {t(`adminUsers.invite.${key}`)}
      </label>
      <input
        id={`${id}-${key}`}
        type={type}
        required
        autoComplete="off"
        className={INPUT_CLASS}
        value={input[key]}
        onChange={(e) => set(key)(e.target.value)}
      />
    </div>
  );

  const message =
    problem === 'email'
      ? t('adminUsers.invite.badEmail')
      : problem === 'name'
        ? t('adminUsers.invite.needName')
        : error;

  return (
    <form
      className={SECTION_CLASS}
      onSubmit={submit}
      noValidate
      data-testid="invite-user"
    >
      <div className="flex items-center gap-2">
        <UserPlus
          className="h-4 w-4 text-slate-500 dark:text-slate-400"
          aria-hidden="true"
        />
        <h4 className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {t('adminUsers.invite.title')}
        </h4>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        {t('adminUsers.invite.hint')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {field('email', 'email')}
        <div>
          <label
            htmlFor={`${id}-role`}
            className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
          >
            {t('adminUsers.role')}
          </label>
          <select
            id={`${id}-role`}
            className={INPUT_CLASS}
            value={input.role}
            onChange={(e) => {
              if (isRole(e.target.value)) set('role')(e.target.value);
            }}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`adminUsers.roles.${role}`)}
              </option>
            ))}
          </select>
        </div>
        {field('given_name')}
        {field('family_name')}
      </div>
      {message && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {message}
        </p>
      )}
      <button type="submit" className={PRIMARY_CLASS} disabled={busy}>
        {busy && (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        )}
        {t('adminUsers.invite.submit')}
      </button>
    </form>
  );
}

interface AdminUsersSettingsProps {
  fetchApi: <T>(url: string, init?: RequestInit) => Promise<T>;
  currentUsername: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Settings → Users (admins): the Cognito users of the app's pool. */
export default function AdminUsersSettings({
  fetchApi,
  currentUsername,
}: AdminUsersSettingsProps) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<PoolUser[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      const list = parsePoolUserList(await fetchApi('admin/users'));
      setUsers(list.users);
      setTruncated(list.truncated);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [fetchApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (raw: unknown) => {
    const user = parsePoolUser(raw);
    if (!user) return;
    setUsers((prev) =>
      prev
        ? prev.some((u) => u.username === user.username)
          ? prev.map((u) => (u.username === user.username ? user : u))
          : [...prev, user].sort((a, b) => a.username.localeCompare(b.username))
        : [user],
    );
  };

  const run = async (
    username: string,
    request: () => Promise<unknown>,
    done: (result: unknown) => string,
  ) => {
    setBusyUser(username);
    setActionError(null);
    setNotice(null);
    try {
      setNotice(done(await request()));
    } catch (e) {
      setActionError(describeUsersError(t, e));
    } finally {
      setBusyUser(null);
      setConfirming(null);
    }
  };

  const path = (username: string, suffix: string) =>
    `admin/users/${encodeURIComponent(username)}/${suffix}`;

  const confirm = ({ username, action }: PendingAction) => {
    if (action === 'reset') {
      void run(
        username,
        () => fetchApi(path(username, 'reset-password'), { method: 'POST' }),
        (result) =>
          (result as { result?: string } | undefined)?.result ===
          'invite_resent'
            ? t('adminUsers.notice.inviteResent', { user: username })
            : t('adminUsers.notice.resetSent', { user: username }),
      );
      return;
    }
    void run(
      username,
      () => fetchApi(path(username, action), { method: 'POST' }),
      (result) => {
        replace(result);
        return t(`adminUsers.notice.${action}d`, { user: username });
      },
    );
  };

  const changeRole = (user: PoolUser, role: Role) => {
    if (role === user.role) return;
    void run(
      user.username,
      () =>
        fetchApi(path(user.username, 'role'), {
          method: 'PUT',
          headers: JSON_HEADERS,
          body: JSON.stringify({ role }),
        }),
      (result) => {
        replace(result);
        return t('adminUsers.notice.role', {
          user: user.username,
          role: t(`adminUsers.roles.${role}`),
        });
      },
    );
  };

  const invite = async (input: InviteInput) => {
    setInviting(true);
    setInviteError(null);
    setNotice(null);
    try {
      const created = await fetchApi('admin/users', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      });
      replace(created);
      setNotice(
        t('adminUsers.notice.invited', {
          user: parsePoolUser(created)?.username ?? input.email,
          email: input.email,
        }),
      );
      return true;
    } catch (e) {
      setInviteError(describeUsersError(t, e));
      return false;
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="admin-users-settings">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-[var(--color-accent)]" />
        <h3
          className="text-base font-semibold"
          style={{ color: 'var(--color-text-primary)' }}
        >
          {t('adminUsers.title')}
        </h3>
        <button
          type="button"
          className={`${BUTTON_CLASS} ml-auto`}
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('adminUsers.refresh')}
        >
          <RefreshCw
            className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          {t('adminUsers.refresh')}
        </button>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        {t('adminUsers.intro')}
      </p>
      <InviteUserForm busy={inviting} error={inviteError} onInvite={invite} />
      <div aria-live="polite">
        {notice && (
          <p className="text-sm text-green-700 dark:text-green-400">{notice}</p>
        )}
        {actionError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {actionError}
          </p>
        )}
      </div>
      {loadError != null && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('adminUsers.loadFailed', {
            message: describeUsersError(t, loadError),
          })}
        </p>
      )}
      {users && (
        <div className={SECTION_CLASS}>
          <AdminUsersTable
            users={users}
            currentUsername={currentUsername}
            busyUser={busyUser}
            confirming={confirming}
            onAsk={setConfirming}
            onCancel={() => setConfirming(null)}
            onConfirm={confirm}
            onRole={changeRole}
          />
          {truncated && (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('adminUsers.truncated')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
