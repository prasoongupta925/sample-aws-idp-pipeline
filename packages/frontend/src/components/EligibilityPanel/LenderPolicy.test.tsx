// @vitest-environment node
// (Rendered to static markup like BranchFinder.test.tsx: effects do not run,
// so the requests are tested through the functions the hook calls.)
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next, { type TFunction } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../i18n/locales/en.json';
import { ApiError } from '../../lib/apiError';
import LenderPolicyPanel, {
  IDLE_POLICY_STATE,
  LENDER_POLICY_PATH,
  LenderPolicyCard,
  PolicyPreviewView,
  describePolicyError,
  fetchLenderPolicy,
  fetchPolicyDownload,
  isoDateText,
  parameterRows,
  parseLenderPolicy,
  parsePolicyPreview,
  policyValueText,
  removeLenderPolicy,
  reuploadByText,
  roiRange,
  shortRupees,
  uploadLenderPolicy,
  uploadName,
  type LenderPolicyCardProps,
  type LenderPolicyState,
} from './LenderPolicy';

vi.mock('../../hooks/useAwsClient', () => ({
  useAwsClient: () => ({ fetchApi: async () => undefined }),
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

const t: TFunction = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options)) as TFunction;

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>{node}</I18nextProvider>,
  );
}

function plain(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// A synthetic workbook as the API answers it (two banks, two categories).
const cell = (value: number | null, ref: string) => ({ value, cell: ref });
const RAW_PREVIEW = {
  filename: 'Policy.xlsx',
  preview: true,
  effective_date: '2026-07-01',
  categories: [
    { code: 'CAT_A', label: 'CAT A' },
    { code: 'CAT_B', label: 'CAT B' },
  ],
  parameters: {
    roi: 'ROI',
    foir: 'FOIR',
    multiplier: 'Multiplier',
    max_funding: 'Maximum Funding',
    max_tenure_months: 'Maximum Tenure',
    calculation_tenure_months: 'Tenure for Eligibility Calculation',
  },
  banks: [
    {
      lender_id: 'hdfc_bank',
      name: 'HDFC Bank',
      new: false,
      slabs: [
        {
          start: 50000,
          row: 5,
          values: {
            roi: { CAT_A: cell(0.11, 'C5'), CAT_B: cell(0.12, 'D5') },
            foir: { CAT_A: cell(0.6, 'J5'), CAT_B: cell(0.55, 'K5') },
            max_funding: {
              CAT_A: cell(5000000, 'X5'),
              CAT_B: cell(3000000, 'Y5'),
            },
          },
        },
        {
          start: 25000,
          row: 4,
          values: {
            roi: { CAT_A: cell(0.13, 'C4'), CAT_B: cell(0.135, 'D4') },
            foir: { CAT_A: cell(0.45, 'J4'), CAT_B: cell(0.5, 'K4') },
            max_funding: {
              CAT_A: cell(5000000, 'X4'),
              CAT_B: cell(3000000, 'Y4'),
            },
          },
        },
      ],
      rules: {
        plbt: 3,
        raw: {
          PLBT: { text: '3', cell: 'F3' },
          'Bonus Calculation': { text: 'Last 2 years *70% / 24', cell: 'I3' },
        },
      },
    },
    {
      lender_id: 'bandhan_bank',
      name: 'Bandhan Bank',
      new: true,
      slabs: [],
      rules: null,
    },
    { lender_id: '', name: 'No id' },
  ],
  warnings: [
    '4 rows share slab 35,000 for HDFC Bank with different ROI; the first is used, please check',
  ],
  notes: ['"Quartery" read as Quarterly'],
  current: null,
};

const STATUS = {
  filename: 'Policy.xlsx',
  uploaded_at: '2026-10-05T10:00:00+00:00',
  expires_at: '2026-10-12T10:00:00+00:00',
  reupload_by: '12 Oct 2026',
  effective_date: '2026-07-01',
  size: 12345,
  sha256: 'ab',
  banks: ['HDFC Bank', 'Bandhan Bank'],
  lender_ids: ['hdfc_bank', 'bandhan_bank'],
  warnings: ['check this'],
};

const RAW_INFO = {
  current: STATUS,
  company_list: { stored: false },
  retention_days: 7,
  max_upload_bytes: 4194304,
};

function stub(answer: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchApi = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer;
  }) as <T>(url: string, init?: RequestInit) => Promise<T>;
  return { calls, fetchApi };
}

describe('parsing', () => {
  it('reads the preview: banks sorted by slab, rules from raw, bad banks dropped', () => {
    const p = parsePolicyPreview(RAW_PREVIEW);
    expect(p.banks.map((b) => b.lender_id)).toEqual([
      'hdfc_bank',
      'bandhan_bank',
    ]);
    const [hdfc, bandhan] = p.banks;
    expect(hdfc.slabs.map((s) => s.start)).toEqual([25000, 50000]);
    expect(hdfc.rules).toEqual([
      { header: 'PLBT', text: '3', cell: 'F3' },
      {
        header: 'Bonus Calculation',
        text: 'Last 2 years *70% / 24',
        cell: 'I3',
      },
    ]);
    expect(bandhan.new).toBe(true);
    expect(bandhan.rules).toEqual([]);
    expect(p.parameters[0]).toEqual(['roi', 'ROI']);
    expect(p.categories[1]).toEqual({ code: 'CAT_B', label: 'CAT B' });
    expect(p.effective_date).toBe('2026-07-01');
    expect(p.warnings).toHaveLength(1);
    expect(p.current).toBeNull();
  });

  it('refuses an answer without banks', () => {
    expect(() => parsePolicyPreview({ detail: 'x' })).toThrow();
  });

  it('reads the status, with or without a stored policy', () => {
    const info = parseLenderPolicy(RAW_INFO);
    expect(info.current?.filename).toBe('Policy.xlsx');
    expect(info.current?.banks).toEqual(['HDFC Bank', 'Bandhan Bank']);
    expect(info.retention_days).toBe(7);
    expect(info.max_upload_bytes).toBe(4194304);
    expect(parseLenderPolicy({ current: null }).current).toBeNull();
  });
});

describe('requests', () => {
  const file = { name: 'C:\\x\\Policy.xlsx', bytes: new Uint8Array([80, 75]) };

  it('previews: the raw bytes, octet-stream, ?filename and ?preview=true', async () => {
    const { calls, fetchApi } = stub(RAW_PREVIEW);
    const p = await uploadLenderPolicy(fetchApi, file, true);
    expect(p.banks).toHaveLength(2);
    expect(calls[0].url).toBe(
      `${LENDER_POLICY_PATH}?filename=Policy.xlsx&preview=true`,
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(file.bytes);
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe(
      'application/octet-stream',
    );
  });

  it('saves without ?preview', async () => {
    const { calls, fetchApi } = stub({
      ...RAW_PREVIEW,
      preview: false,
      current: STATUS,
    });
    const p = await uploadLenderPolicy(fetchApi, file, false);
    expect(calls[0].url).toBe(`${LENDER_POLICY_PATH}?filename=Policy.xlsx`);
    expect(p.current?.reupload_by).toBe('12 Oct 2026');
  });

  it('gets the status, the download link and removes', async () => {
    const status = stub(RAW_INFO);
    expect((await fetchLenderPolicy(status.fetchApi)).current).not.toBeNull();
    expect(status.calls[0].url).toBe(LENDER_POLICY_PATH);

    const link = stub({
      url: 'https://s3.example/x?sig=1',
      filename: 'Policy.xlsx',
    });
    expect(await fetchPolicyDownload(link.fetchApi)).toEqual({
      url: 'https://s3.example/x?sig=1',
      filename: 'Policy.xlsx',
    });
    expect(link.calls[0].url).toBe(`${LENDER_POLICY_PATH}/download`);
    await expect(
      fetchPolicyDownload(stub({ url: 'ftp://example/x' }).fetchApi),
    ).rejects.toThrow();

    const del = stub({ deleted: true });
    expect(await removeLenderPolicy(del.fetchApi)).toBe(true);
    expect(del.calls[0].init?.method).toBe('DELETE');
  });

  it('cleans the file name: folders and control characters gone, 200 at most', () => {
    expect(uploadName('a/b\\Pol\u0007icy.xlsx')).toBe('Pol icy.xlsx');
    const long = uploadName(`${'x'.repeat(300)}.xlsx`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('.xlsx')).toBe(true);
  });

  it("shows the API's reason for a refused file, and admin-only on 403", () => {
    expect(
      describePolicyError(
        t,
        new ApiError(
          415,
          'Macro-enabled workbooks (.xlsm) are not accepted: save it as .xlsx',
        ),
      ),
    ).toContain('.xlsm');
    expect(describePolicyError(t, new ApiError(403, 'no'))).toBe(
      en.eligibility.lenderPolicy.adminOnly,
    );
  });
});

describe('wording', () => {
  it('a policy kept until replaced has no re-upload date', () => {
    expect(
      reuploadByText({ ...STATUS, expires_at: null, reupload_by: null }),
    ).toBeNull();
    expect(reuploadByText(STATUS)).not.toBeNull();
  });

  it('formats the sheet values', () => {
    expect(policyValueText('roi', 0.135)).toBe('13.5%');
    expect(policyValueText('foir', 0.5)).toBe('50%');
    expect(policyValueText('multiplier', 24)).toBe('24×');
    expect(policyValueText('max_funding', 5000000)).toBe('₹50 L');
    expect(policyValueText('max_tenure_months', 60)).toBe('60');
    expect(policyValueText('roi', null)).toBe('–');
    expect(shortRupees(12500000)).toBe('₹1.25 Cr');
    expect(isoDateText('2026-07-01')).toBe(
      new Date(Date.UTC(2026, 6, 1)).toLocaleDateString([], {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    );
    expect(isoDateText('nonsense')).toBeNull();
  });

  it('folds a parameter with the same values in every slab into one row', () => {
    const p = parsePolicyPreview(RAW_PREVIEW);
    const [hdfc] = p.banks;
    const funding = parameterRows(hdfc, 'max_funding', p.categories);
    expect(funding).toHaveLength(1);
    expect(funding[0].start).toBeNull();
    expect(funding[0].values[0].cells).toEqual(['X4', 'X5']);
    const roi = parameterRows(hdfc, 'roi', p.categories);
    expect(roi.map((r) => r.start)).toEqual([25000, 50000]);
    expect(roi[0].values.map((v) => v.value)).toEqual([0.13, 0.135]);
    expect(roiRange(hdfc)).toEqual([0.11, 0.135]);
    expect(roiRange(p.banks[1])).toBeNull();
  });
});

function card(
  state: Partial<LenderPolicyState>,
  props: Partial<LenderPolicyCardProps> = {},
): string {
  const noop = () => undefined;
  return render(
    <LenderPolicyCard
      open
      onToggle={noop}
      state={{ ...IDLE_POLICY_STATE, ...state }}
      onRetry={noop}
      onChoose={noop}
      onSave={noop}
      onCancel={noop}
      onDownload={noop}
      onRemove={noop}
      {...props}
    />,
  );
}

describe('LenderPolicyCard', () => {
  it('closed: the toggle line says which file and until when', () => {
    const html = card({ info: parseLenderPolicy(RAW_INFO) }, { open: false });
    const text = plain(html);
    expect(text).toContain('Lender policy (Excel)');
    expect(text).toContain('Policy.xlsx');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('policy-status');
  });

  it('no policy stored: says the sample policies apply, offers Choose only', () => {
    const html = card({
      info: parseLenderPolicy({ current: null, retention_days: 7 }),
    });
    const text = plain(html);
    expect(html).toContain('data-stored="false"');
    expect(text).toContain(en.eligibility.lenderPolicy.none);
    expect(text).toContain(en.eligibility.lenderPolicy.choose);
    expect(text).not.toContain(en.eligibility.lenderPolicy.download);
    expect(html).toContain('accept=".xlsx,');
    expect(html).not.toContain('.xlsm');
  });

  it('stored: current policy line with upload, effective date, re-upload by and Download original', () => {
    const text = plain(card({ info: parseLenderPolicy(RAW_INFO) }));
    expect(text).toContain('Policy.xlsx');
    expect(text).toContain(isoDateText('2026-07-01') as string);
    expect(text).toMatch(/re-upload/i);
    expect(text).toContain(en.eligibility.lenderPolicy.download);
    expect(text).toContain(en.eligibility.lenderPolicy.replace);
    expect(text).toContain('HDFC Bank, Bandhan Bank');
  });

  it('the intro says the sheet is kept until a new one is uploaded, not deleted after 7 days', () => {
    const text = plain(card({ info: parseLenderPolicy(RAW_INFO) }));
    expect(text).toContain(en.eligibility.lenderPolicy.intro);
    expect(text).toContain('kept until you upload a new one or remove it');
    expect(text).not.toMatch(/deleted after \d+ days/);
  });

  it('shows a failure and a retry when the status cannot be read', () => {
    const text = plain(card({ loadError: new ApiError(502, 'x') }));
    expect(text).toContain(en.eligibility.branches.retry);
  });

  it('shows a refused file', () => {
    const html = card({
      info: parseLenderPolicy(RAW_INFO),
      outcome: { ok: false, error: 'Only .xlsx workbooks are accepted' },
    });
    expect(html).toContain('policy-error');
    expect(plain(html)).toContain('Only .xlsx workbooks are accepted');
  });

  it('a chosen file: preview with warnings, the grid and the Sheet2 rules, then Save', () => {
    const preview = parsePolicyPreview(RAW_PREVIEW);
    const html = card({
      info: parseLenderPolicy(RAW_INFO),
      pending: {
        file: { name: 'Policy.xlsx', bytes: new Uint8Array() },
        preview,
      },
    });
    const text = plain(html);
    expect(html).toContain('policy-preview');
    expect(html).toContain('policy-warnings');
    expect(text).toContain('4 rows share slab 35,000 for HDFC Bank');
    expect(text).toContain('CAT A');
    expect(text).toContain('13.5%');
    expect(text).toContain('Last 2 years *70% / 24');
    expect(html).toContain(
      `title="${t('eligibility.lenderPolicy.cells', { cells: 'D4' })}"`,
    );
    expect(text).toContain(en.eligibility.lenderPolicy.newBank);
    expect(text).toContain(en.eligibility.lenderPolicy.save);
    expect(text).toContain('"Quartery" read as Quarterly');
  });

  it('a clean workbook says there is nothing to check', () => {
    const preview = parsePolicyPreview({ ...RAW_PREVIEW, warnings: [] });
    const noop = () => undefined;
    const text = plain(
      render(
        <PolicyPreviewView
          preview={preview}
          busy={null}
          onSave={noop}
          onCancel={noop}
        />,
      ),
    );
    expect(text).toContain(en.eligibility.lenderPolicy.noWarnings);
  });

  it('disables the buttons while saving', () => {
    const preview = parsePolicyPreview(RAW_PREVIEW);
    const noop = () => undefined;
    const html = render(
      <PolicyPreviewView
        preview={preview}
        busy="save"
        onSave={noop}
        onCancel={noop}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('LenderPolicyPanel', () => {
  it('renders nothing for a user who is not an admin (outside sign-in: no user)', () => {
    expect(render(<LenderPolicyPanel />)).toBe('');
  });
});
