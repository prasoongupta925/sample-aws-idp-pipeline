// @vitest-environment node
// The DOM comes from ../../test/jsdom (the stock jsdom environment cannot
// start in this workspace); it must be imported before testing-library.
import '../../test/jsdom';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useState } from 'react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import en from '../../i18n/locales/en.json';
import CreditReportGuide from '.';
import CibilSection from '../EligibilityPanel/CibilSection';
import { Route } from '../../routes/help/credit-report';
import { normalizeInputs } from '../../lib/eligibility';
import { SAVED_INPUTS_RESPONSE } from '../EligibilityPanel/fixtures';
import type { GuideLang } from '../../data/creditReportGuide';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

function Switchable() {
  const [lang, setLang] = useState<GuideLang>('en');
  return <CreditReportGuide lang={lang} onLangChange={setLang} />;
}

describe('credit report guide page', () => {
  it('switches between English, Hindi and Marathi', () => {
    render(<Switchable />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'How to get your free credit report',
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'English' })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'अपनी मुफ़्त क्रेडिट रिपोर्ट कैसे पाएँ',
      }),
    ).toBeTruthy();
    expect(screen.getByTestId('credit-report-guide').getAttribute('lang')).toBe(
      'hi',
    );

    fireEvent.click(screen.getByRole('button', { name: 'मराठी' }));
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'तुमचा मोफत क्रेडिट रिपोर्ट कसा मिळवायचा',
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'मराठी' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('opens each bureau’s main site in a new tab, without the opener', () => {
    render(<Switchable />);

    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.cibil.com/',
      'https://www.experian.in/',
      'https://www.equifax.co.in/',
      'https://www.crifhighmark.com/',
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('is the /help/credit-report route, in the language of the link', async () => {
    const Page = Route.options.component;
    if (!Page) throw new Error('the help route has no component');
    const rootRoute = createRootRoute({ component: Outlet });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/help/credit-report',
          validateSearch: Route.options.validateSearch,
          component: Page,
        }),
      ]),
      history: createMemoryHistory({
        initialEntries: ['/help/credit-report?lang=mr'],
      }),
    });
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'तुमचा मोफत क्रेडिट रिपोर्ट कसा मिळवायचा',
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'अपनी मुफ़्त क्रेडिट रिपोर्ट कैसे पाएँ',
      }),
    ).toBeTruthy();
    expect(router.state.location.search).toEqual({ lang: 'hi' });
  });

  it('is linked from the CIBIL tab, in a new tab', () => {
    const inputs = normalizeInputs(SAVED_INPUTS_RESPONSE.inputs);
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <CibilSection cibil={inputs.cibil} onEdit={() => undefined} />
      </I18nextProvider>,
    );

    const link = html.match(
      /<a [^>]*data-testid="credit-report-help-link"[^>]*>/,
    )?.[0];
    expect(link).toBeDefined();
    expect(link).toContain('href="/help/credit-report"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(html).toContain('How the customer gets a free credit report');
  });
});
