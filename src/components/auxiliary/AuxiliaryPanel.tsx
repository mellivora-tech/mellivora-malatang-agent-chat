import { Files, FileDiff, Info, type LucideIcon } from 'lucide-react';
import { type KeyboardEvent } from 'react';
import { useAgentStore, type AuxiliaryTab } from '../../store/useAgentStore';

const auxiliaryTabs: Array<{ tab: AuxiliaryTab; label: string; icon: LucideIcon }> = [
	{ tab: 'changes', label: 'Changes', icon: FileDiff },
	{ tab: 'files', label: 'Files', icon: Files },
	{ tab: 'details', label: 'Details', icon: Info }
];

const auxiliaryTabId = (tab: AuxiliaryTab) => `aux-tab-${tab}`;
const auxiliaryPanelId = (tab: AuxiliaryTab) => `aux-tabpanel-${tab}`;

export function AuxiliaryPanel() {
	const activeAuxiliaryTab = useAgentStore(state => state.activeAuxiliaryTab);
	const setActiveAuxiliaryTab = useAgentStore(state => state.setActiveAuxiliaryTab);
	const activeSessionId = useAgentStore(state => state.activeSessionId);
	const session = useAgentStore(state => (state.activeSessionId ? state.sessionsById[state.activeSessionId] : null));
	const fileChanges = useAgentStore(state => (state.activeSessionId ? state.fileChangesBySessionId[state.activeSessionId] ?? [] : []));
	const files = useAgentStore(state => (state.activeSessionId ? state.filesBySessionId[state.activeSessionId] ?? [] : []));

	const currentTabIndex = auxiliaryTabs.findIndex(tabConfig => tabConfig.tab === activeAuxiliaryTab);
	const safeTabIndex = currentTabIndex === -1 ? 0 : currentTabIndex;

	const focusTab = (tab: AuxiliaryTab) => {
		const tabElement = document.getElementById(auxiliaryTabId(tab));
		tabElement?.focus();
	};

	const selectTab = (tab: AuxiliaryTab) => {
		setActiveAuxiliaryTab(tab);
		focusTab(tab);
	};

	const handleTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		let nextIndex = safeTabIndex;

		switch (event.key) {
			case 'ArrowRight': {
				event.preventDefault();
				nextIndex = (safeTabIndex + 1) % auxiliaryTabs.length;
				break;
			}
			case 'ArrowLeft': {
				event.preventDefault();
				nextIndex = (safeTabIndex - 1 + auxiliaryTabs.length) % auxiliaryTabs.length;
				break;
			}
			case 'Home': {
				event.preventDefault();
				nextIndex = 0;
				break;
			}
			case 'End': {
				event.preventDefault();
				nextIndex = auxiliaryTabs.length - 1;
				break;
			}
			default:
				return;
		}

		setActiveAuxiliaryTab(auxiliaryTabs[nextIndex]!.tab);
		focusTab(auxiliaryTabs[nextIndex]!.tab);
	};

	return (
		<aside aria-label="Auxiliary Panel" className="auxiliary-panel">
			<div className="panel-header">
				<span>Auxiliary Panel</span>
				<span className="aux-meta">{activeSessionId ? session?.title : 'No session'}</span>
			</div>
			<div className="aux-tabs" role="tablist" aria-label="Auxiliary Panel Tabs" onKeyDown={handleTabListKeyDown}>
				{auxiliaryTabs.map(({ tab, label, icon: Icon }) => (
					<button
						key={tab}
						id={auxiliaryTabId(tab)}
						aria-selected={activeAuxiliaryTab === tab}
						aria-controls={auxiliaryPanelId(tab)}
						tabIndex={activeAuxiliaryTab === tab ? 0 : -1}
						className="aux-tab"
						role="tab"
						type="button"
						onClick={() => selectTab(tab)}
					>
						<Icon size={14} aria-hidden="true" />
						<span>{label}</span>
					</button>
				))}
			</div>
			{auxiliaryTabs.map(({ tab }) => {
				const isActive = activeAuxiliaryTab === tab;

				return (
					<div
						key={tab}
						className="aux-panel-body"
						role="tabpanel"
						id={auxiliaryPanelId(tab)}
						aria-labelledby={auxiliaryTabId(tab)}
						hidden={!isActive}
					>
						{!session ? (
							<div className="aux-empty">Select a session to inspect changes, files, and details.</div>
						) : tab === 'changes' ? (
							fileChanges.length > 0 ? (
								<ul className="aux-list">
									{fileChanges.map(change => (
										<li key={change.id} className="aux-list-item">
											<div>{change.path}</div>
											<div className="change-meta">
												{change.status} • +{change.additions} / -{change.deletions}
											</div>
										</li>
									))}
								</ul>
							) : (
								<div className="aux-empty">No tracked changes for this session.</div>
							)
						) : tab === 'files' ? (
							files.length > 0 ? (
								<ul className="aux-list">
									{files.map(file => (
										<li key={file.id} className="aux-list-item">
											<div>{file.path}</div>
											<div className="file-meta">
												{file.type} • depth {file.depth}
											</div>
										</li>
									))}
								</ul>
							) : (
								<div className="aux-empty">No files in this session workspace.</div>
							)
						) : (
							<div className="details-grid">
								<div className="details-key">Provider</div>
								<div className="details-value">{session.providerName}</div>
								<div className="details-key">Workspace</div>
								<div className="details-value">{session.workspaceLabel}</div>
								<div className="details-key">Updated</div>
								<div className="details-value">{new Date(session.updatedAt).toLocaleString()}</div>
								<div className="details-key">Status</div>
								<div className="details-value">{session.status}</div>
								<div className="details-key">Pinned</div>
								<div className="details-value">{session.pinned ? 'Yes' : 'No'}</div>
								<div className="details-key">Unread</div>
								<div className="details-value">{session.unread ? 'Yes' : 'No'}</div>
							</div>
						)}
					</div>
				);
			})}
		</aside>
	);
}
