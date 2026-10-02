// @vitest-environment node
import { fileTabAccept, isVideoFileName } from './uploadAccept';

const extensions = (accept: string) => accept.split(',');

describe('upload accept list', () => {
  it('offers video only in a build with a video model', () => {
    const withVideo = extensions(fileTabAccept(true));
    const withoutVideo = extensions(fileTabAccept(false));

    for (const ext of ['.mp4', '.mov', '.avi']) {
      expect(withVideo).toContain(ext);
      expect(withoutVideo).not.toContain(ext);
    }
    // Documents, images and audio (Transcribe) stay in both.
    for (const ext of [
      '.pdf',
      '.docx',
      '.png',
      '.jpg',
      '.mp3',
      '.wav',
      '.flac',
    ]) {
      expect(withVideo).toContain(ext);
      expect(withoutVideo).toContain(ext);
    }
    expect(withVideo.filter((ext) => !withoutVideo.includes(ext))).toEqual([
      '.mp4',
      '.mov',
      '.avi',
    ]);
  });

  it('recognises video file names', () => {
    for (const name of [
      'site_visit.mp4',
      'KYC.MOV',
      'clip.avi',
      'clip.mkv',
      'call.webm',
    ]) {
      expect(isVideoFileName(name), name).toBe(true);
    }
    for (const name of [
      'call.wav',
      'call.mp3',
      'call.m4a',
      'statement.pdf',
      'mp4.pdf',
    ]) {
      expect(isVideoFileName(name), name).toBe(false);
    }
  });
});
