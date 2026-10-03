// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import { RuntimeConfigContext } from '../RuntimeConfig';
import ChatInputBox from './ChatInputBox';

// utils.ts loads isomorphic-dompurify (jsdom); the input box needs two helpers.
vi.mock('./utils', () => ({
  formatFileSize: (bytes: number) => `${bytes} B`,
  getFileTypeInfo: () => ({ label: 'File', color: '' }),
}));

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

function renderInput(
  voice: { available?: boolean; mode: boolean },
  onOpenVoiceBot?: () => void,
) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RuntimeConfigContext.Provider value={{ apis: {} }}>
        <ChatInputBox
          inputMessage=""
          sending={false}
          attachedFiles={[]}
          setAttachedFiles={noop}
          artifacts={[]}
          documents={[]}
          agents={[]}
          selectedAgent={null}
          onInputChange={noop}
          onSendMessage={noop}
          onAgentClick={noop}
          voiceChat={{
            ...voice,
            selectedModel: 'nova_sonic',
            setMode: noop,
            handleDisable: noop,
            handleEnable: noop,
          }}
          onOpenVoiceBot={onOpenVoiceBot}
          messagesLength={0}
          setPendingAgentChange={noop}
          setShowRemoveAgentConfirm={noop}
          inputRef={createRef<HTMLDivElement>()}
          fileInputRef={createRef<HTMLInputElement>()}
        />
      </RuntimeConfigContext.Provider>
    </I18nextProvider>,
  );
}

describe('ChatInputBox voice chat', () => {
  it('shows the voice chip and mic in voice mode where voice chat exists', () => {
    const html = renderInput({ available: true, mode: true });
    expect(html).toContain('Nova Sonic');
    expect(html).toContain('lucide-mic');
  });

  it('shows no mic without a voice chat runtime, even in a stale voice mode', () => {
    for (const available of [false, undefined]) {
      const html = renderInput({ available, mode: true });
      expect(html).not.toContain('Nova Sonic');
      expect(html).not.toContain('lucide-mic');
      // The send button keeps the text-chat colour.
      expect(html).not.toContain('bg-purple-500');
    }
  });

  it('offers no Tools menu for voice alone when the build has no voice chat', () => {
    // No agent picker and no voice chat: nothing to show in the Tools menu.
    expect(renderInput({ available: false, mode: false })).not.toContain(
      'Tools',
    );
    expect(renderInput({ available: true, mode: false })).toContain('Tools');
  });
});

describe('ChatInputBox voice bot', () => {
  it('shows the chat microphone and the Tools menu when a voice bot URL is set', () => {
    const html = renderInput({ available: false, mode: false }, noop);
    expect(html).toContain('lucide-mic');
    expect(html).toContain(`aria-label="${en.voiceChat.title}"`);
    expect(html).toContain('Tools');
  });

  it('hides both without a voice bot URL', () => {
    const html = renderInput({ available: false, mode: false });
    expect(html).not.toContain('lucide-mic');
    expect(html).not.toContain(`aria-label="${en.voiceChat.title}"`);
  });
});
