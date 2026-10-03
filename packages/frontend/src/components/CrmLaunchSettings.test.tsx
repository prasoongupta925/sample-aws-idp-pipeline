// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { CrmLaunchSecretPanel } from './CrmLaunchSettings';
import { LaunchView } from '../routes/launch';
import { ApiError } from '../lib/apiError';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: unknown }) => (
    <a href="/">{children as string}</a>
  ),
  useNavigate: () => () => undefined,
}));
vi.mock('../hooks/useAwsClient', () => ({ useAwsClient: () => ({}) }));

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

function panel(props: Partial<Parameters<typeof CrmLaunchSecretPanel>[0]>) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <CrmLaunchSecretPanel
        settings={{
          secret_set: false,
          rotated_at: null,
          rotated_by: null,
          max_lifetime_s: 300,
        }}
        secret={null}
        busy={false}
        confirming={false}
        error={null}
        onGenerate={noop}
        onAskConfirm={noop}
        onCancelConfirm={noop}
        onDismissSecret={noop}
        {...props}
      />
    </I18nextProvider>,
  );
}

describe('CrmLaunchSecretPanel', () => {
  it('offers to generate the first secret', () => {
    const html = panel({});
    expect(html).toContain('Not set');
    expect(html).toContain('Generate secret');
  });

  it('asks before rotating a set secret', () => {
    const settings = {
      secret_set: true,
      rotated_at: '2026-10-01T10:00:00+00:00',
      rotated_by: 'asha.verma',
      max_lifetime_s: 300,
    };
    expect(panel({ settings })).toContain('Rotate secret');
    expect(panel({ settings })).toContain('asha.verma');
    const confirm = panel({ settings, confirming: true });
    expect(confirm).toContain('role="alertdialog"');
    expect(confirm).toContain('stop working at once');
  });

  it('shows a new secret once, with a warning', () => {
    const html = panel({ secret: 'new-secret-value' });
    expect(html).toContain('value="new-secret-value"');
    expect(html).toContain('It is not shown again');
  });

  it('shows why a rotation failed', () => {
    const html = panel({ error: new ApiError(403, 'Only admins can do this') });
    expect(html).toContain('Could not rotate the secret');
  });
});

describe('LaunchView', () => {
  const render = (error: unknown, message: string | null) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <LaunchView error={error} message={message} />
      </I18nextProvider>,
    );

  it('says it is opening the lead', () => {
    expect(render(null, null)).toContain('Opening the lead from the CRM');
  });

  it('explains a refused link', () => {
    const html = render(new ApiError(400, 'x'), 'The launch link has expired');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The launch link has expired');
    expect(html).toContain('Go to projects');
  });
});
