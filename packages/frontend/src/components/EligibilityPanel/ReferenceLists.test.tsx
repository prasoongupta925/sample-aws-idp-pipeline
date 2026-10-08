// @vitest-environment node
// The DSA's own lists (BranchFinder): saving or removing a list the
// eligibility calculation reads (the policy sheet, the company list, the
// pincode list) tells the panel, which then checks the banks again; the
// branch list does not. The DOM comes from ../../test/jsdom (the stock jsdom
// environment cannot start in this workspace); it must be imported before
// testing-library.
import '../../test/jsdom';
import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { useReferenceLists, type ReferenceKind } from './BranchFinder';

const t = ((key: string) => key) as unknown as TFunction;
const csv = () =>
  new File(['lender,name\r\n'], 'list.csv', { type: 'text/csv' });

function setup() {
  const sent: string[] = [];
  const fetchApi = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? 'GET';
    sent.push(`${method} ${url}`);
    if (method === 'POST') {
      const kind = new URL(url, 'https://api.example.test/').searchParams.get(
        'kind',
      );
      return { kind, uploaded: true, rows: 3 } as T;
    }
    if (method === 'DELETE') return { deleted: true } as T;
    return { lists: [] } as T;
  };
  const onChanged = vi.fn();
  const onPolicyChanged = vi.fn();
  const hook = renderHook(() =>
    useReferenceLists(fetchApi, 'proj_demo', t, onChanged, onPolicyChanged),
  );
  return { hook, sent, onChanged, onPolicyChanged };
}

describe('useReferenceLists: a list the banks read changed', () => {
  it.each<[ReferenceKind, number]>([
    ['company_categories', 1],
    ['pincode_serviceability', 1],
    ['lender_branches', 0],
  ])('saving a %s list tells the panel %i time(s)', async (kind, times) => {
    const { hook, onChanged, onPolicyChanged } = setup();
    await act(async () => hook.result.current.upload(kind, csv()));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onPolicyChanged).toHaveBeenCalledTimes(times);
  });

  it('a policy sheet: when saved after its preview, not on the preview', async () => {
    const { hook, sent, onPolicyChanged } = setup();
    await act(async () => hook.result.current.upload('lender_grid', csv()));
    expect(sent[0]).toContain('kind=lender_grid');
    expect(sent[0]).toContain('preview=true');
    expect(onPolicyChanged).not.toHaveBeenCalled();
    await act(async () => hook.result.current.save());
    expect(onPolicyChanged).toHaveBeenCalledTimes(1);
  });

  it('removing a company list tells the panel; removing the branches does not', async () => {
    const { hook, onPolicyChanged } = setup();
    await act(async () => hook.result.current.remove('company_categories'));
    expect(onPolicyChanged).toHaveBeenCalledTimes(1);
    await act(async () => hook.result.current.remove('lender_branches'));
    expect(onPolicyChanged).toHaveBeenCalledTimes(1);
  });
});
