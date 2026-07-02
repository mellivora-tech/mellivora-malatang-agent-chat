import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { useAgentStore } from './store/useAgentStore';

export function App() {
	const initialize = useAgentStore(state => state.initialize);
	const initialized = useAgentStore(state => state.initialized);

	useEffect(() => {
		if (!initialized) {
			void initialize();
		}
	}, [initialize, initialized]);

	return <AppShell />;
}
