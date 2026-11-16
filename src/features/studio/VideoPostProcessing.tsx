import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useI18n } from '../../i18n/I18nProvider';
import { inspectVideoPost, inspectVideoPostPath, type VideoPostInspection } from '../../lib/videoPost';
import { normalizedMediaPath, type MediaDeletion, type MediaItem } from '../../lib/media';

const blockerCodes = ['cadenceUnknown', 'cadenceMismatch', 'interlaced', 'rotation', 'alpha', 'hdr', 'colorUnknown', 'unsupportedPixelFormat', 'multipleVideoStreams', 'unsupportedDimensions', 'fieldOrderUnknown', 'nonSquarePixels', 'pixelAspectUnknown'];

/** Only a successful inspection replaces the workspace source; cancellation retains it. */
export function VideoPostProcessing({ onInspected, disabled = false, acquire, release, picked }: { onInspected?: (source: VideoPostInspection | null) => void; disabled?: boolean; acquire?: () => boolean; release?: () => void; /** A Media-panel tile (video with a path): inspected natively like a chooser pick. */ picked?: MediaItem | null }) {
  const { t } = useI18n();
  const [source, setSource] = useState<VideoPostInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const epoch = useRef(0);
  const sourcePath = useRef<string | undefined>(undefined);
  const inspecting = useRef<{ path?: string; deleted: boolean } | null>(null);
  useEffect(() => {
    const removed = (event: Event) => {
      const paths = new Set((event as CustomEvent<MediaDeletion>).detail.deleted.map(normalizedMediaPath));
      if (inspecting.current?.path && paths.has(normalizedMediaPath(inspecting.current.path))) inspecting.current.deleted = true;
      if (sourcePath.current && paths.has(normalizedMediaPath(sourcePath.current))) {
        sourcePath.current = undefined;
        setSource(null);
        onInspected?.(null);
      }
    };
    window.addEventListener('deas-media-deleted', removed);
    return () => window.removeEventListener('deas-media-deleted', removed);
  }, [onInspected]);
  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => { if (picked?.path && picked.media === 'video') void choose(picked.path); }, [picked]);

  async function choose(path?: string) {
    if (pending.current || disabled || !isTauri() || (acquire && !acquire())) return;
    pending.current = true;
    const current = epoch.current;
    const inspection = { path, deleted: false };
    inspecting.current = inspection;
    setError(null);
    setBusy(true);
    try {
      const selected = path ? await inspectVideoPostPath(path) : await inspectVideoPost(t('studio.videoPost.dialog'));
      if (epoch.current === current && !inspection.deleted && selected) { sourcePath.current = path; setSource(selected); onInspected?.(selected); }
    } catch (failure) {
      if (epoch.current === current && !inspection.deleted) {
        const detail = failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure);
        setError(detail);
      }
    } finally {
      inspecting.current = null;
      release?.();
      if (epoch.current === current) { pending.current = false; setBusy(false); }
    }
  }

  return <section className="wb-option" data-video-post aria-label={t('studio.videoPost.title')} aria-busy={busy}>
    <span>{t('studio.videoPost.title')}</span>
    <button type="button" className="wb-dock-action" data-video-post-inspect disabled={disabled || busy || !isTauri()} onClick={() => void choose()}>{t('studio.videoPost.choose')}</button>
    {busy && <small role="status">{t('studio.videoPost.busy')}</small>}
    {!isTauri() && <small>{t('studio.videoPost.desktop')}</small>}
    {error !== null && <small role="alert">{t('studio.videoPost.failed')}: {error}</small>}
    {source && <div data-video-post-source>
      <strong>{source.name}</strong>
      <div><small>{source.width} × {source.height} · {source.fpsNumerator > 0 ? `${source.fpsNumerator}/${source.fpsDenominator} fps` : t('studio.videoPost.blocker.cadenceUnknown')}{source.durationSeconds !== null && ` · ${source.durationSeconds} s`}</small></div>
      <div><small>{t('studio.videoPost.streams', { audio: source.audioStreams, subtitles: source.subtitleStreams })}</small></div>
      <div><small>{source.pixelFormat} · {source.fieldOrder} · {source.colorTransfer}</small></div>
      {source.blockers.length > 0 && <ul>{source.blockers.map((code, index) => <li key={`${code}-${index}`} data-video-post-blocker><small>{t(`studio.videoPost.blocker.${blockerCodes.includes(code) ? code : 'unknown'}`)}</small></li>)}</ul>}
    </div>}
    <small>{t('studio.videoPost.limit')}</small>
  </section>;
}
