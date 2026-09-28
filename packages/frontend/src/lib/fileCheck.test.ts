// @vitest-environment node
import {
  CSV_HEADERS,
  buildFileCheckCsv,
  consistencyTone,
  csvCell,
  fileCheckCsvFileName,
  fileCheckFindings,
  itemTone,
  normalizeChecklists,
  pickDefaultChecklistId,
  verdictTone,
} from './fileCheck';
import { NOT_READY_RESULT } from '../components/FileCheckPanel/fixtures';

describe('normalizeChecklists', () => {
  it('accepts the engine list_checklists object', () => {
    const { checklists, defaultId } = normalizeChecklists({
      default_checklist: 'ss_pl_sal',
      checklists: [
        { id: 'salaried_personal_loan', name: 'Personal Loan - Salaried' },
        { id: 'ss_pl_sal', name: 'Smart Solutions - PL - Salaried' },
      ],
    });
    expect(checklists.map((c) => c.id)).toEqual([
      'salaried_personal_loan',
      'ss_pl_sal',
    ]);
    expect(defaultId).toBe('ss_pl_sal');
  });

  it('accepts a bare list with label instead of name and drops bad rows', () => {
    const { checklists, defaultId } = normalizeChecklists([
      { id: 'a', label: 'A list' },
      { id: 'a', name: 'duplicate' },
      { name: 'no id' },
      null,
    ]);
    expect(checklists).toEqual([
      {
        id: 'a',
        name: 'A list',
        product: null,
        applicant_type: null,
        description: null,
      },
    ]);
    expect(defaultId).toBeNull();
  });

  it('ignores a default that is not in the list', () => {
    expect(
      normalizeChecklists({ default_checklist: 'x', items: [{ id: 'a' }] })
        .defaultId,
    ).toBeNull();
  });
});

describe('pickDefaultChecklistId', () => {
  const list = [
    { id: 'ss_hl_sal', name: 'HL', product: 'home_loan' },
    {
      id: 'ls_pl_sal',
      name: 'PL',
      product: 'personal_loan',
      applicant_type: 'salaried',
    },
    { id: 'salaried_personal_loan', name: 'Personal Loan - Salaried' },
  ];

  it('prefers the API default', () => {
    expect(pickDefaultChecklistId(list, 'ss_hl_sal')).toBe('ss_hl_sal');
  });

  it('falls back to the salaried personal-loan checklist', () => {
    expect(pickDefaultChecklistId(list, null)).toBe('salaried_personal_loan');
    expect(pickDefaultChecklistId(list.slice(0, 2))).toBe('ls_pl_sal');
    expect(pickDefaultChecklistId(list.slice(0, 1))).toBe('ss_hl_sal');
    expect(pickDefaultChecklistId([])).toBe('');
  });
});

describe('tones', () => {
  it('maps verdicts without deciding them', () => {
    expect(verdictTone('READY')).toBe('ready');
    expect(verdictTone('NOT READY')).toBe('notReady');
    expect(verdictTone('not_ready')).toBe('notReady');
    expect(verdictTone('NEEDS REVIEW')).toBe('review');
    expect(verdictTone('NEEDS_REVIEW')).toBe('review');
    expect(verdictTone('SOMETHING ELSE')).toBe('unknown');
  });

  it('maps item and consistency statuses', () => {
    expect(itemTone('PRESENT')).toBe('ok');
    expect(itemTone('MISSING')).toBe('bad');
    expect(itemTone('MISSING', false)).toBe('muted');
    expect(itemTone('REVIEW')).toBe('review');
    expect(consistencyTone('MISMATCH')).toBe('bad');
    expect(consistencyTone('N/A')).toBe('muted');
    expect(consistencyTone('INFO')).toBe('info');
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and new lines and neutralises formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('@sum')).toBe("'@sum");
    expect(csvCell(null)).toBe('');
  });

  it('has one row per finding', () => {
    const findings = fileCheckFindings(NOT_READY_RESULT);
    // 4 checklist items + 2 consistency checks + 1 unsupported document
    expect(findings).toHaveLength(7);
    expect(findings.map((f) => f.section)).toEqual([
      'Checklist',
      'Checklist',
      'Checklist',
      'Checklist',
      'Consistency',
      'Consistency',
      'Not checked',
    ]);
    expect(findings[3].item).toBe('Form-16 / ITR (optional)');
    expect(findings[6]).toMatchObject({
      applicant: '',
      item: 'statement.xlsx',
      status: 'UNSUPPORTED',
      documents: ['statement.xlsx'],
    });
  });

  it('is Excel-friendly UTF-8 with a BOM and CRLF rows', () => {
    const csv = buildFileCheckCsv(NOT_READY_RESULT);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    // header + 7 findings + trailing empty string after the final CRLF
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe('');
    expect(lines[2]).toBe(
      [
        'Amit Suresh Patil',
        'NOT READY',
        'Personal Loan - Salaried',
        'Checklist',
        'Salary slips (last 3 months)',
        'MISSING',
        '"missing Jun 2026, Jul 2026 slip(s); found: Aug 2026 (slip_aug.pdf)"',
        'slip_aug.pdf',
      ].join(','),
    );
    expect(csv).toContain('₹72,000');
    expect(csv).toContain('application.pdf; slip_aug.pdf');
  });

  it('keeps ₹ and Devanagari as UTF-8 bytes after the BOM', async () => {
    const csv = buildFileCheckCsv({
      ...NOT_READY_RESULT,
      applicants: [
        { ...NOT_READY_RESULT.applicants[0], applicant: 'अमित सुरेश पाटील' },
      ],
    });
    const bytes = new Uint8Array(
      await new Blob([csv], { type: 'text/csv;charset=utf-8' }).arrayBuffer(),
    );
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8').decode(bytes.slice(3));
    expect(text).toContain('अमित सुरेश पाटील,NOT READY,');
    expect(text).toContain('₹72,000');
  });

  it('builds a safe file name', () => {
    expect(fileCheckCsvFileName(NOT_READY_RESULT)).toBe(
      'file-check_salaried-personal-loan_2026-09-28.csv',
    );
    expect(fileCheckCsvFileName(NOT_READY_RESULT, 'Amit S. Patil')).toBe(
      'file-check_salaried-personal-loan_amit-s-patil_2026-09-28.csv',
    );
  });
});
