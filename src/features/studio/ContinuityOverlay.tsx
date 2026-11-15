import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { ContinuityPlanner, type ContinuityPlannerProps } from './ContinuityPlanner';
import './continuity-overlay.css';

export type ContinuityOverlayProps = ContinuityPlannerProps & { onClose: () => void; blocker?:string };

export function ContinuityOverlay({ onClose, blocker, ...planner }: ContinuityOverlayProps) {
  const { t } = useI18n();
  const [joinBusy,setJoinBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  const dismiss = () => {
    if (joinBusy) return;
    if (dialogRef.current?.open) dialogRef.current.close();
    onClose();
  };
  // Chromium can make repeated dialog-cancel gestures non-cancelable; block the busy key first.
  return <dialog ref={dialogRef} className="continuity-overlay" aria-labelledby={titleId} onKeyDown={event=>{if(joinBusy&&event.key==='Escape'){event.preventDefault();event.stopPropagation();}}} onCancel={event => { event.preventDefault(); dismiss(); }}>
    <header className="continuity-overlay-header"><h2 id={titleId}>{t('studio.run.dock.continuity')}</h2>
      <button ref={closeRef} type="button" disabled={joinBusy} onClick={dismiss}>{t('studio.close')}</button>
    </header>
    <div className="continuity-overlay-body">{blocker&&<p role="status">{blocker}</p>}<ContinuityPlanner {...planner} running={planner.running||joinBusy} onJoinBusyChange={setJoinBusy}/></div>
  </dialog>;
}
