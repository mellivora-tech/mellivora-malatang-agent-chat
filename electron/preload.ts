import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('agentDesktop', {
	platform: () => process.platform
});
