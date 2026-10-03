// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import ToolsMenuPopover from './ToolsMenuPopover';

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

function renderMenu(
  available: boolean | undefined,
  mode = false,
  onOpenVoiceBot?: () => void,
) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ToolsMenuPopover
        voiceChat={{
          available,
          mode,
          selectedModel: 'nova_sonic',
          onModelSelect: noop,
          onDisable: noop,
          onEnable: noop,
          setMode: noop,
        }}
        onOpenVoiceBot={onOpenVoiceBot}
        onAgentSelect={noop}
        selectedAgent={null}
        agents={[]}
        messagesLength={0}
        onAgentClick={noop}
        onClose={noop}
        onPendingAgentChange={noop}
        onShowRemoveAgentConfirm={noop}
      />
    </I18nextProvider>,
  );
}

describe('ToolsMenuPopover', () => {
  it('offers Voice Chat where the build has a voice chat runtime', () => {
    expect(renderMenu(true)).toContain(en.voiceChat.title);
  });

  it('has no Voice Chat item and no mic without one (the Mumbai build)', () => {
    for (const available of [false, undefined]) {
      const html = renderMenu(available);
      expect(html).not.toContain(en.voiceChat.title);
      expect(html).not.toContain('lucide-mic');
      // The agents stay usable.
      expect(html).toContain(en.chat.useAgent);
    }
  });

  it('never locks the agent menu for a voice mode the build does not have', () => {
    const html = renderMenu(false, true);
    expect(html).not.toContain('disabled=""');
    expect(renderMenu(true, true)).toContain('disabled=""');
  });

  it('offers Voice Chat for the voice bot panel without a voice chat runtime', () => {
    const html = renderMenu(false, false, noop);
    expect(html).toContain(en.voiceChat.title);
    expect(html).toContain('lucide-mic');
    expect(html).not.toContain('disabled=""');
  });

  it('shows one Voice Chat item when both exist (the voice bot replaces the toggle)', () => {
    const html = renderMenu(true, true, noop);
    expect(html.split(en.voiceChat.title)).toHaveLength(2);
    expect(html).not.toContain('lucide-check');
    expect(html).not.toContain('disabled=""');
  });
});
