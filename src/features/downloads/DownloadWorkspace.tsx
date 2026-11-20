import {DownloadPanel} from './DownloadPluginPanel';
import type {DownloadStatus} from '../../lib/downloads';
/** Library receives credential invalidations from the owning Backend workspace.
 * The panel stays mounted while another tab is shown: the catalog view, the selection
 * basket and a running background download queue survive workspace tab switches. The
 * panel element itself carries `hidden`, so the workspace layout stays identical to an
 * unmounted Library. */
export function DownloadWorkspace({view,installTarget,modelsDir,authRevision,onStatus}:{view:'downloads'|null;installTarget?:string;modelsDir?:string;authRevision:number;onStatus?:(status:DownloadStatus)=>void}){
 return <DownloadPanel embedded hidden={view!=='downloads'} authRevision={authRevision} installTarget={installTarget} modelsDir={modelsDir} onStatus={onStatus}/>;
}
