// The GPU OCR endpoint (PaddleOCR-VL on SageMaker) is opt-in at deploy time.
// Without it every sagemaker/* route answers 404, so the Settings page asks
// sagemaker/availability first and only shows its OCR section when the
// endpoint exists.

export type SettingsSection =
  | 'sagemaker'
  | 'integrations'
  | 'users'
  | 'license';

type FetchApi = <T>(path: string, options?: RequestInit) => Promise<T>;

/** True only when the backend says the endpoint exists; false on any error. */
export async function checkOcrEndpointAvailable(
  fetchApi: FetchApi,
): Promise<boolean> {
  try {
    const result = await fetchApi<{ available?: unknown }>(
      'sagemaker/availability',
    );
    return result?.available === true;
  } catch {
    return false;
  }
}

/**
 * The Settings menu entries to show: the OCR one waits for a yes, the admin
 * ones (integrations, users) only for an admin (the API enforces the role).
 */
export function visibleSettingsSections(
  ocrAvailable: boolean | null,
  admin = false,
): SettingsSection[] {
  return [
    ...(ocrAvailable === true ? (['sagemaker'] as const) : []),
    ...(admin ? (['integrations', 'users'] as const) : []),
    'license',
  ];
}
