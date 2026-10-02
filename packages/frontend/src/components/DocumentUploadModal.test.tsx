// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { RuntimeConfigContext } from './RuntimeConfig';
import DocumentUploadModal from './DocumentUploadModal';

// pdf.js only counts PDF pages here; it needs browser APIs to load.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

function renderModal(videoUploadsEnabled?: boolean, bdaEnabled?: boolean) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RuntimeConfigContext.Provider
        value={{ apis: {}, videoUploadsEnabled, bdaEnabled }}
      >
        <DocumentUploadModal
          isOpen
          uploading={false}
          onClose={() => undefined}
          onUpload={async () => undefined}
        />
      </RuntimeConfigContext.Provider>
    </I18nextProvider>,
  );
}

const acceptOf = (html: string) =>
  /id="file-upload-input"[^>]*accept="([^"]*)"/.exec(html)?.[1] ??
  /accept="([^"]*)"[^>]*id="file-upload-input"/.exec(html)?.[1];

describe('DocumentUploadModal video uploads', () => {
  it('leaves video out of the picker in a build without a video model', () => {
    const html = renderModal(false);
    const accept = acceptOf(html)?.split(',') ?? [];

    expect(accept).toContain('.pdf');
    expect(accept).toContain('.wav');
    expect(accept).not.toContain('.mp4');
    expect(accept).not.toContain('.mov');
    expect(html).toContain(en.documents.supportedFormatsNoVideo);
    expect(html).not.toContain('videos (MP4, MOV, AVI)');
  });

  it('keeps video where the build has a video model (and by default)', () => {
    for (const enabled of [true, undefined]) {
      const html = renderModal(enabled);
      expect(acceptOf(html)?.split(',')).toContain('.mp4');
      expect(html).toContain(en.documents.supportedFormats);
    }
  });

  it('explains a refused video and points to the audio path', () => {
    expect(en.documents.videoNotSupported).toContain('{{files}}');
    expect(en.documents.videoNotSupported).toMatch(/audio/i);
  });
});

describe('DocumentUploadModal BDA option', () => {
  it('hides BDA in a build without it (cross-Region profile, ap-south-1)', () => {
    const html = renderModal(false, false);
    expect(html).not.toContain(en.documents.bdaTooltip);
    expect(html).not.toContain('Bedrock Analysis');
    expect(html).toContain('grid-cols-2');
    // OCR is still offered.
    expect(html).toContain(en.documents.ocrTooltip);
  });

  it('offers BDA where the build has it (and by default)', () => {
    for (const enabled of [true, undefined]) {
      const html = renderModal(true, enabled);
      expect(html).toContain(en.documents.bdaTooltip);
      expect(html).toContain('Bedrock Analysis');
      expect(html).toContain('grid-cols-3');
    }
  });
});
