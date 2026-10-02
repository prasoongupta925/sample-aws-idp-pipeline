// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import ProjectSettingsModal, {
  crmLeadIdForSave,
  crmLeadIdValid,
  type Project,
} from './ProjectSettingsModal';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const PROJECT: Project = {
  project_id: 'proj_demo',
  name: 'Asha Verma',
  description: '',
  status: 'active',
  language: 'en',
  color: 0,
  crm_lead_id: 'SD-LEAD-0042',
};

describe('CRM lead id', () => {
  it.each(['', '  ', 'SD-LEAD-0042', 'a.b_c:d-1', 'x'.repeat(64)])(
    'accepts %j',
    (value) => expect(crmLeadIdValid(value)).toBe(true),
  );

  it.each(['has space', 'x'.repeat(65), 'semi;colon', 'ünï'])(
    'refuses %j',
    (value) => expect(crmLeadIdValid(value)).toBe(false),
  );

  it('omits a blank lead id on create and clears it on edit', () => {
    expect(crmLeadIdForSave('  ', true)).toEqual({});
    expect(crmLeadIdForSave('', false)).toEqual({ crm_lead_id: '' });
    expect(crmLeadIdForSave(' L-1 ', true)).toEqual({ crm_lead_id: 'L-1' });
  });

  it('shows the project lead id in the basic settings', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <ProjectSettingsModal
          project={PROJECT}
          isOpen
          onClose={() => undefined}
          onSave={async () => undefined}
        />
      </I18nextProvider>,
    );
    expect(html).toContain('CRM lead ID');
    expect(html).toContain('data-testid="project-crm-lead-id"');
  });
});
