// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { AdminUsersTable, InviteUserForm } from './AdminUsersSettings';
import { ApiError } from '../lib/apiError';
import {
  describeUsersError,
  inviteProblem,
  parsePoolUserList,
  type PoolUser,
} from '../lib/adminUsers';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const noop = () => undefined;

const asha: PoolUser = {
  username: 'asha.verma',
  email: 'asha@example.com',
  given_name: 'Asha',
  family_name: 'Verma',
  status: 'CONFIRMED',
  enabled: true,
  created_at: '2026-09-01T00:00:00+00:00',
  role: 'admin',
};
const rohan: PoolUser = {
  ...asha,
  username: 'rohan.iyer',
  email: 'rohan@example.com',
  given_name: 'Rohan',
  family_name: 'Iyer',
  role: 'handler',
};

function table(props: Partial<Parameters<typeof AdminUsersTable>[0]>) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AdminUsersTable
        users={[asha, rohan]}
        currentUsername="asha.verma"
        busyUser={null}
        confirming={null}
        onAsk={noop}
        onCancel={noop}
        onConfirm={noop}
        onRole={noop}
        {...props}
      />
    </I18nextProvider>,
  );
}

const rowOf = (html: string, username: string) => {
  const at = html.indexOf(`>${username}`);
  const start = html.lastIndexOf('<tr', at);
  return html.slice(start, html.indexOf('</tr>', at));
};

describe('AdminUsersTable', () => {
  it('lists users with name, email, role and status', () => {
    const html = table({});
    expect(html).toContain('Asha Verma');
    expect(html).toContain('rohan.iyer · rohan@example.com');
    expect(html).toContain('aria-label="Role of rohan.iyer"');
    expect(html).toContain('Enabled');
  });

  it('locks the role and disable button on the own row only', () => {
    const html = table({});
    const own = rowOf(html, 'asha.verma');
    expect(own).toContain('(you)');
    expect(own).toContain('title="You cannot disable your own account."');
    expect(own).toMatch(/<select[^>]*disabled/);
    expect(rowOf(html, 'rohan.iyer')).not.toMatch(/<select[^>]*disabled/);
  });

  it('asks before disabling', () => {
    const html = table({
      confirming: { username: 'rohan.iyer', action: 'disable' },
    });
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Disable rohan.iyer?');
  });

  it('offers enable for a disabled user and resend for an invited one', () => {
    const html = table({
      users: [
        { ...rohan, enabled: false },
        {
          ...rohan,
          username: 'new.joiner',
          status: 'FORCE_CHANGE_PASSWORD',
          role: null,
        },
      ],
    });
    expect(html).toContain('Disabled');
    expect(html).toContain('>Enable<');
    expect(html).toContain('Invited, not signed in yet');
    expect(html).toContain('Resend invite');
    expect(html).toContain('No role');
  });

  it('says when there are no users', () => {
    expect(table({ users: [] })).toContain('No users yet.');
  });
});

describe('InviteUserForm', () => {
  const form = (error: string | null) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <InviteUserForm
          busy={false}
          error={error}
          onInvite={async () => true}
        />
      </I18nextProvider>,
    );

  it('has labelled fields and the three roles, handler first chosen', () => {
    const html = form(null);
    for (const label of ['Email', 'First name', 'Last name', 'Role']) {
      expect(html).toContain(`>${label}</label>`);
    }
    expect(html).toContain('<option value="handler" selected="">');
    expect(html).toContain('temporary password');
  });

  it('shows a server error', () => {
    expect(form('A user with this username or email already exists')).toContain(
      'role="alert"',
    );
  });
});

describe('admin users helpers', () => {
  it('parses the list and drops malformed users', () => {
    const list = parsePoolUserList({
      users: [asha, { email: 'x' }, { ...rohan, role: 'owner' }],
      truncated: true,
    });
    expect(list.users.map((u) => u.username)).toEqual([
      'asha.verma',
      'rohan.iyer',
    ]);
    expect(list.users[1].role).toBeNull();
    expect(list.truncated).toBe(true);
  });

  it('checks the invite input', () => {
    const ok = {
      email: 'a@example.com',
      given_name: 'A',
      family_name: 'B',
      role: 'viewer' as const,
    };
    expect(inviteProblem(ok)).toBeNull();
    expect(inviteProblem({ ...ok, email: 'nope' })).toBe('email');
    expect(inviteProblem({ ...ok, family_name: ' ' })).toBe('name');
  });

  it('describes errors', () => {
    const t = i18n.t.bind(i18n);
    expect(describeUsersError(t, new ApiError(403))).toBe(
      'Only admins can manage users.',
    );
    expect(describeUsersError(t, new ApiError(409, 'You cannot x'))).toBe(
      'You cannot x',
    );
    expect(describeUsersError(t, new ApiError(502, 'Cognito down'))).toBe(
      'The request was rejected (HTTP 502). (Cognito down)',
    );
  });
});
