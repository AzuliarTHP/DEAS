import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
  isTauri: () => true,
}));

import { invoke } from '@tauri-apps/api/core';
import { deleteMedia } from './media';

describe('deleteMedia releases live preview handles before deleting (Windows)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('unloads matching <video> and <audio> sources before the native delete runs', async () => {
    document.body.innerHTML =
      '<video id="match" src="asset://localhost//out/source.mp4?v=3"></video>' +
      '<audio id="match2" src="asset://localhost//out/talk.mp3"></audio>' +
      '<video id="trap" src="asset://localhost//out/source.mp4x"></video>' +
      '<video id="other" src="asset://localhost//elsewhere/keep.mp4"></video>';
    vi.mocked(invoke).mockImplementation(async () => {
      // The preview must already be gone when native sees the delete.
      expect(document.getElementById('match')!.getAttribute('src')).toBeNull();
      expect(document.getElementById('match2')!.getAttribute('src')).toBeNull();
      return { deleted: ['/out/source.mp4', '/out/talk.mp3'], failed: [] };
    });
    const report = await deleteMedia(['/out/source.mp4', '/out/talk.mp3']);
    expect(report.deleted).toHaveLength(2);
    // Suffix look-alikes and untouched previews keep their src.
    expect(document.getElementById('trap')!.getAttribute('src')).toContain('source.mp4x');
    expect(document.getElementById('other')!.getAttribute('src')).toContain('keep.mp4');
  });
});
