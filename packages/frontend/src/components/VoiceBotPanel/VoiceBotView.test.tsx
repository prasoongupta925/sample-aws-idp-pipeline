// @vitest-environment node
// (Rendered to static markup: the workspace's jsdom install cannot start.)
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineItem } from '../../lib/voicebot/captions';
import type { SessionEnd } from '../../lib/voicebot/session';
import VoiceBotView, {
  endMessage,
  formatDuration,
  showPostCall,
  type VoiceBotViewProps,
} from './VoiceBotView';
import { findQaProject } from './index';
import type { Project } from '../ProjectSettingsModal';

vi.mock('./useVoiceBotCall', () => ({ useVoiceBotCall: vi.fn() }));
vi.mock('../../hooks/useAwsClient', () => ({ useAwsClient: vi.fn() }));
vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: vi.fn() }));

const noop = () => undefined;

function render(overrides: Partial<VoiceBotViewProps> = {}) {
  return renderToStaticMarkup(
    <VoiceBotView
      language="en-IN"
      onLanguageChange={noop}
      talkMode="handsfree"
      onTalkModeChange={noop}
      held={false}
      onHeldChange={noop}
      phase="idle"
      callLanguage={null}
      items={[]}
      speaking={false}
      audioSuspended={false}
      end={null}
      qaHref=""
      maxCallMinutes={10}
      onCall={noop}
      onEnd={noop}
      onResumeAudio={noop}
      onOpenQa={noop}
      onClose={noop}
      {...overrides}
    />,
  );
}

const CARDS: TimelineItem[] = [
  {
    id: 1,
    role: 'user',
    text: 'What is missing in my file?',
    interim: '',
    closed: true,
  },
  {
    id: 2,
    role: 'card',
    card: {
      type: 'file_status',
      verdict: 'NOT_READY',
      missing: ['Form 16'],
      mismatches: 1,
    },
  },
  {
    id: 3,
    role: 'card',
    card: {
      type: 'eligibility',
      bestLender: 'Synthetic Bank',
      amount: '₹12,00,000',
    },
  },
  {
    id: 4,
    role: 'card',
    card: {
      type: 'reminder',
      text: 'Dear Asha Verma, please share Form 16.',
      language: 'en-IN',
      channel: 'whatsapp',
      template: 'missing_docs',
      placeholders: [],
    },
  },
  {
    id: 5,
    role: 'bot',
    text: 'I have drafted the reminder.',
    closed: true,
    interrupted: false,
  },
];

describe('VoiceBotView', () => {
  it('has the language picker, one Call button and the recorded notice', () => {
    const html = render();
    for (const label of ['English', 'हिन्दी', 'मराठी'])
      expect(html).toContain(label);
    expect(html).toContain('AI assistant · this call is recorded');
    expect(html).toContain('aria-label="Start the call"');
    expect(html).not.toContain('aria-label="End the call"');
    expect(html).toContain('role="dialog"');
  });

  it('turns the button into End and locks the picker during a call', () => {
    const html = render({ phase: 'live', callLanguage: 'en-IN' });
    expect(html).toContain('aria-label="End the call"');
    expect(html).not.toContain('aria-label="Start the call"');
    expect(html).toContain(
      '<fieldset class="flex items-center gap-1" disabled=""',
    );
    expect(html).toContain('Listening… speak now');
  });

  it('follows the call language once the bot switches it', () => {
    const html = render({ phase: 'live', callLanguage: 'hi-IN' });
    expect(html).toContain('lang="hi"');
    expect(html).not.toContain('Listening… speak now');
  });

  it('shows captions of both sides and the three result cards, the reminder with Copy', () => {
    const html = render({ phase: 'live', callLanguage: 'en-IN', items: CARDS });
    expect(html).toContain('What is missing in my file?');
    expect(html).toContain('I have drafted the reminder.');
    expect(html).toContain('File check');
    expect(html).toContain('NOT READY');
    expect(html).toContain('Form 16');
    expect(html).toContain('1 detail(s) do not match');
    expect(html).toContain('Indicative eligibility');
    expect(html).toContain('₹12,00,000 with Synthetic Bank');
    expect(html).toContain('Indicative only. The lender decides.');
    expect(html).toContain('WhatsApp reminder · draft, not sent');
    expect(html).toContain('Dear Asha Verma, please share Form 16.');
    expect(html).toContain('>Copy<');
  });

  it('shows a blocked microphone as a readable alert, with no post-call note', () => {
    const end: SessionEnd = { error: 'errMicDenied', seconds: 0 };
    const html = render({ phase: 'ended', end, qaHref: '/projects/qa1' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('The microphone is blocked.');
    expect(html).not.toContain('Open Telecaller QA');
  });

  it('after a call, says the recording went to Telecaller QA and links to it', () => {
    const end: SessionEnd = {
      reason: 'assistant',
      detail: 'end_call',
      seconds: 75,
    };
    const html = render({ phase: 'ended', end, qaHref: '/projects/qa1' });
    expect(html).toContain('The assistant ended the call');
    expect(html).toContain('1:15');
    expect(html).toContain('the conversation was complete');
    expect(html).toContain('uploaded to Telecaller QA');
    expect(html).toContain('href="/projects/qa1"');
    expect(html).toContain('Open Telecaller QA');
    expect(html).not.toContain('role="alert"');
  });

  it('keeps the post-call note but no link when the QA project is not found', () => {
    const end: SessionEnd = { reason: 'user', seconds: 30 };
    const html = render({ phase: 'ended', end, qaHref: '' });
    expect(html).toContain('Call ended');
    expect(html).toContain('uploaded to Telecaller QA');
    expect(html).not.toContain('Open Telecaller QA');
  });
});

describe('outcome helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(605)).toBe('10:05');
  });

  it('builds error texts in the call language', () => {
    expect(endMessage('en-IN', { error: 'errBusy', seconds: 0 }, 10)).toContain(
      'busy',
    );
    expect(
      endMessage('en-IN', { reason: 'limit', seconds: 630 }, 10),
    ).toContain('10 minutes');
    expect(endMessage('en-IN', { reason: 'user', seconds: 3 }, 10)).toBe('');
    expect(
      endMessage(
        'en-IN',
        { error: 'errRejected', detail: 'origin', seconds: 0 },
        10,
      ),
    ).toContain('origin');
    expect(
      endMessage('hi-IN', { error: 'errMicDenied', seconds: 0 }, 10),
    ).not.toBe(endMessage('en-IN', { error: 'errMicDenied', seconds: 0 }, 10));
  });

  it('shows the post-call note only after a real conversation', () => {
    expect(showPostCall(null)).toBe(false);
    expect(showPostCall({ reason: 'user', seconds: 0.5 })).toBe(false);
    expect(showPostCall({ error: 'errAuth', seconds: 3 })).toBe(false);
    expect(showPostCall({ error: 'errDropped', seconds: 40 })).toBe(true);
    expect(showPostCall({ reason: 'assistant', seconds: 40 })).toBe(true);
  });
});

describe('findQaProject', () => {
  const p = (project_id: string, name: string) =>
    ({ project_id, name }) as Project;

  it('prefers the default Telecaller QA project name', () => {
    expect(
      findQaProject([
        p('a', 'Home loans'),
        p('b', 'Telecaller QA – old'),
        p('c', 'Telecaller QA – Sample calls'),
      ])?.project_id,
    ).toBe('c');
    expect(
      findQaProject([p('a', 'Home loans'), p('b', 'Telecaller QA – old')])
        ?.project_id,
    ).toBe('b');
    expect(findQaProject([p('a', 'Home loans')])).toBeUndefined();
  });
});

describe('hold to talk / hands-free', () => {
  const checked = (html: string, value: string) =>
    /checked=""/.test(
      html.match(new RegExp(`<input[^>]*value="${value}"[^>]*>`))?.[0] ?? '',
    );

  it('offers both modes before the call, with the chosen one checked', () => {
    const html = render({ talkMode: 'ptt' });
    expect(html).toContain('Hold to talk');
    expect(html).toContain('Hands-free');
    expect(checked(html, 'ptt')).toBe(true);
    expect(checked(html, 'handsfree')).toBe(false);
    expect(checked(render({ talkMode: 'handsfree' }), 'handsfree')).toBe(true);
    expect(html).not.toContain('aria-pressed'); // no hold button before the call
  });

  it('a live hold-to-talk call shows the hold button and tells how to speak', () => {
    const up = render({
      phase: 'live',
      callLanguage: 'en-IN',
      talkMode: 'ptt',
    });
    expect(up).toContain('aria-pressed="false"');
    expect(up).toContain('Hold the button (or Space) and speak');
    const down = render({
      phase: 'live',
      callLanguage: 'en-IN',
      talkMode: 'ptt',
      held: true,
    });
    expect(down).toContain('aria-pressed="true"');
    expect(down).toContain('Release to send');
    expect(down).toContain('Speak now… release to send');
    const hindi = render({
      phase: 'live',
      callLanguage: 'hi-IN',
      talkMode: 'ptt',
    });
    expect(hindi).toContain('दबाकर रखें और बोलें');
  });

  it('a hands-free call has no hold button and keeps listening; the mode is locked in a call', () => {
    const html = render({
      phase: 'live',
      callLanguage: 'en-IN',
      talkMode: 'handsfree',
    });
    expect(html).not.toContain('aria-pressed');
    expect(html).toContain('Listening… speak now');
    expect(html.match(/<fieldset[^>]*disabled=""/g)).toHaveLength(2);
  });
});
