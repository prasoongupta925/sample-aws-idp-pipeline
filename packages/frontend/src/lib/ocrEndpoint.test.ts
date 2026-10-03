// @vitest-environment node
import {
  checkOcrEndpointAvailable,
  visibleSettingsSections,
} from './ocrEndpoint';

describe('OCR endpoint availability', () => {
  it('asks the availability route, not the status route', async () => {
    const fetchApi = vi.fn().mockResolvedValue({ available: true });

    await expect(checkOcrEndpointAvailable(fetchApi)).resolves.toBe(true);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith('sagemaker/availability');
  });

  it('is false when the backend says the endpoint is absent', async () => {
    const fetchApi = vi.fn().mockResolvedValue({ available: false });
    await expect(checkOcrEndpointAvailable(fetchApi)).resolves.toBe(false);
  });

  it('is false when the check fails or answers oddly', async () => {
    await expect(
      checkOcrEndpointAvailable(vi.fn().mockRejectedValue(new Error('404'))),
    ).resolves.toBe(false);
    await expect(
      checkOcrEndpointAvailable(
        vi.fn().mockResolvedValue({ available: 'yes' }),
      ),
    ).resolves.toBe(false);
    await expect(
      checkOcrEndpointAvailable(vi.fn().mockResolvedValue(null)),
    ).resolves.toBe(false);
  });
});

describe('Settings sections', () => {
  it('hides the OCR section until the endpoint is known to exist', () => {
    expect(visibleSettingsSections(null)).toEqual(['license']);
    expect(visibleSettingsSections(false)).toEqual(['license']);
    expect(visibleSettingsSections(true)).toEqual(['sagemaker', 'license']);
  });
});
