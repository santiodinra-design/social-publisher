// Runs in the sandboxed renderer. Exposes only these four calls; no Node or Electron objects leak out.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('publisher', {
	pickVideo(onProgress: (p: number) => void) {
		const on = (_e: unknown, p: unknown) => typeof p === 'number' && onProgress(Math.max(0, Math.min(1, p)));
		ipcRenderer.on('upload-progress', on);
		return ipcRenderer.invoke('pick-video').finally(() => ipcRenderer.removeListener('upload-progress', on));
	},
	openExternal: (url: string) => ipcRenderer.invoke('open-external', String(url)),
	revealLogs: () => ipcRenderer.invoke('reveal-logs'),
	revealInbox: () => ipcRenderer.invoke('reveal-inbox'),
	services: () => ipcRenderer.invoke('services'),
});
