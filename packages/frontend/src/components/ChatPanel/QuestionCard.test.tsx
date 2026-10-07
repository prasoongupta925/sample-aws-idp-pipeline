// @vitest-environment node
// The DOM comes from ../../test/jsdom (the stock jsdom environment cannot
// start in this workspace); it must be imported before testing-library.
import '../../test/jsdom';
import { fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import ToolResultCard from './ToolResultCard';

// utils.ts loads isomorphic-dompurify; the card needs one helper.
vi.mock('./utils', () => ({
  formatToolDisplayName: (name: string) => name,
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

const LOAN = {
  kind: 'single',
  title: 'Which loan should we check first?',
  options: [
    { id: 'pl', label: 'Personal loan' },
    { id: 'hl', label: 'Home loan' },
  ],
  allowCustom: true,
};
const SALARY = {
  kind: 'text',
  title: 'Monthly net salary?',
  placeholder: 'Amount in rupees',
};

/** An ask_user tool result as the agent sends it. */
const askUser = (...questions: object[]) =>
  JSON.stringify({ _ui_action: 'ask_user', questions });

/** The chat's tool result card, which parses the result on every render. */
function card(content: string, onAnswer: (text: string) => void = vi.fn()) {
  return (
    <I18nextProvider i18n={i18n}>
      <ToolResultCard
        toolName="ask_user"
        content={content}
        expandKeyPrefix="m-1"
        expandedSources={new Set()}
        onToggleExpand={() => undefined}
        onAnswer={onAnswer}
      />
    </I18nextProvider>
  );
}

const other = () => screen.getByPlaceholderText<HTMLInputElement>('Other...');
const button = (name: string) =>
  screen.getByRole<HTMLButtonElement>('button', { name });

describe('ask_user question card', () => {
  it('keeps a typed answer when the chat re-renders the same question', () => {
    const onAnswer = vi.fn();
    const { rerender } = render(card(askUser(LOAN), onAnswer));
    fireEvent.change(other(), { target: { value: 'Gold loan' } });

    // A streamed chunk or a keystroke elsewhere: same text, new objects.
    rerender(card(askUser(LOAN), onAnswer));
    expect(other().value).toBe('Gold loan');

    fireEvent.click(button('Confirm'));
    expect(onAnswer).toHaveBeenCalledWith(
      'Which loan should we check first? -> Gold loan',
    );
  });

  it('keeps a picked option and a typed text across re-renders', () => {
    const onAnswer = vi.fn();
    const spec = askUser(LOAN, SALARY);
    const { rerender } = render(card(spec, onAnswer));
    fireEvent.click(screen.getByText('Home loan'));
    rerender(card(spec, onAnswer));
    fireEvent.click(button('Next'));

    const salary =
      screen.getByPlaceholderText<HTMLTextAreaElement>('Amount in rupees');
    fireEvent.change(salary, { target: { value: '85000' } });
    rerender(card(spec, onAnswer));
    expect(salary.value).toBe('85000');

    fireEvent.click(button('Confirm'));
    expect(onAnswer).toHaveBeenCalledWith(
      'Which loan should we check first? -> Home loan\nMonthly net salary? -> 85000',
    );
  });

  it('starts over for a genuinely new question', () => {
    const { rerender } = render(card(askUser(LOAN)));
    fireEvent.change(other(), { target: { value: 'Gold loan' } });

    // Same title, other options: a different question.
    const options = [{ id: 'bl', label: 'Business loan' }];
    rerender(card(askUser({ ...LOAN, options })));
    expect(other().value).toBe('');
    expect(button('Confirm').disabled).toBe(true);
    expect(screen.getByText('Business loan')).toBeTruthy();
    expect(screen.queryByText('Home loan')).toBeNull();
  });
});
