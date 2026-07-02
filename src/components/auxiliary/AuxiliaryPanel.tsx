import { Files, FileDiff, Info, type LucideIcon } from 'lucide-react';
import { useAgentStore, type AuxiliaryTab } from '../../store/useAgentStore';

const auxiliaryTabs: Array<{ tab: AuxiliaryTab; label: string; icon: LucideIcon }> = [
	{ tab: 'changes', label: 'Changes', icon: FileDiff },
	{ tab: 'files', label: 'Files', icon: Files },
	{ tab: 'details', label: 'Details', icon: Info }
];

export function AuxiliaryPanel() {
	const activeAuxiliaryTab = useAgentStore(state => state.activeAuxiliaryTab);
	const setActiveAuxiliaryTab = useAgentStore(state => state.setActiveAuxiliaryTab);
	const activeSessionId = useAgentStore(state => state.activeSessionId);
	const session = useAgentStore(state => (state.activeSessionId ? state.sessionsById[state.activeSessionId] : null));
	const fileChanges = useAgentStore(state => (state.activeSessionId ? state.fileChangesBySessionId[state.activeSessionId] ?? [] : []));
	const files = useAgentStore(state => (state.activeSessionId ? state.filesBySessionId[state.activeSessionId] ?? [] : []));

	return (
		<aside aria-label="Auxiliary Panel" className="auxiliary-panel">
			<div className="panel-header">
				<span>Auxiliary Panel</span>
				<span className="aux-meta">{activeSessionId ? session?.title : 'No session'}</span>
			</div>
			<div className="aux-tabs" role="tablist" aria-label="Auxiliary Panel Tabs">
				{auxiliaryTabs.map(({ tab, label, icon: Icon }) => (
					<button
						key={tab}
						aria-selected={activeAuxiliaryTab === tab}
						className="aux-tab"
						role="tab"
						type="button"
						onClick={() => setActiveAuxiliaryTab(tab)}
					>
						<Icon size={14} aria-hidden="true" />
						<span>{label}</span>
					</button>
				))}
			</div>
			<div className="aux-panel-body" role="tabpanel">
				{!session ? (
					<div className="aux-empty">Select a session to inspect changes, files, and details.</div>
				) : activeAuxiliaryTab === 'changes' ? (
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
				) : activeAuxiliaryTab === 'files' ? (
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
		</aside>
	);
}
