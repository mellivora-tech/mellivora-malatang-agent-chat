/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import type { ISessionDataBrowse, ISessionMessage, ISessionWorkStep } from '../../../../services/sessions/common/session.js';

export interface IWorkBlockProps {
	readonly message: ISessionMessage;
	readonly onOpenDataBrowser?: ((browse: ISessionDataBrowse) => void) | undefined;
}

/**
 * React port of the old createWorkBlock/patchWorkBlock/updateWorkBlockHeader
 * trio — "Worked for 16m 56s ⌄", one collapsible block per agent run. Expand
 * state and the live-elapsed-time anchor used to live in Maps on
 * ConversationView (workExpandOverride/workFirstSeen), keyed by message id so
 * they'd survive a full DOM rebuild on every patch; here the React root IS
 * the row's lifetime, so they're plain local state/ref instead.
 */
export function WorkBlock(props: IWorkBlockProps): JSX.Element {
	const { message, onOpenDataBrowser } = props;
	const live = message.durationMs === undefined;

	// Anchor for the live "worked for Ns" ticker — set once, the first time this
	// row is seen live. A ref write during render is intentional here (the
	// React-recommended pattern for "compute once, on the render that first
	// needs it") — there is no effect that could run before the first paint.
	const firstSeenRef = useRef<number | undefined>(undefined);
	if (live && firstSeenRef.current === undefined) {
		firstSeenRef.current = Date.now();
	}

	// undefined = no manual override, follow `live` (open while running, closes
	// on completion). Once the user clicks, their choice sticks regardless of
	// live state — same semantics as the old workExpandOverride Map.
	const [expandOverride, setExpandOverride] = useState<boolean | undefined>(undefined);
	const expanded = expandOverride ?? live;

	const title = live
		? localize('conv.workingFor', formatDurationMs(Date.now() - (firstSeenRef.current ?? Date.now())))
		: localize('conv.workedFor', formatDurationMs(message.durationMs ?? 0));

	return (
		<section className={`conversation-work${live ? ' live' : ''}`} data-message-id={message.id}>
			<button type="button" className="conversation-work-header" aria-expanded={expanded} onClick={() => setExpandOverride(!expanded)}>
				{live && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}
				<span className="conversation-work-title">{title}</span>
				<span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} aria-hidden="true" />
			</button>
			<div className="conversation-work-steps" hidden={!expanded}>
				{(message.steps ?? []).map((step, index) => (
					<WorkStepRow key={`${message.id}:${index}`} step={step} onOpenDataBrowser={onOpenDataBrowser} />
				))}
			</div>
		</section>
	);
}

interface IWorkStepRowProps {
	readonly step: ISessionWorkStep;
	readonly onOpenDataBrowser?: ((browse: ISessionDataBrowse) => void) | undefined;
}

/** "⏱ Thought for a few seconds" / "🔧 read_file src/a.ts · 2s" — tool steps expand to their output. */
function WorkStepRow(props: IWorkStepRowProps): JSX.Element {
	const { step, onOpenDataBrowser } = props;
	// Keyed by the parent's `key`, not a messageId:index Set entry (the old
	// stepExpand Set existed only because the DOM version rebuilt every step
	// row from scratch on every patch) — React's keyed reconciliation already
	// keeps this instance, and its state, alive across re-renders.
	const [open, setOpen] = useState(false);
	const browse = step.browse;

	const rowContent = (
		<>
			<span className={`codicon ${step.kind === 'thinking' ? 'codicon-history' : step.kind === 'narration' ? 'codicon-comment' : 'codicon-tools'}`} aria-hidden="true" />
			<span className="conversation-work-step-label">{step.kind === 'thinking' ? localize('conv.thoughtFor', thinkingDurationText(step.durationMs)) : step.label}</span>
			{step.kind !== 'thinking' &&
				step.kind !== 'narration' &&
				(step.running ? (
					<span className="codicon codicon-loading codicon-modifier-spin conversation-work-step-duration" aria-label={localize('conv.running')} />
				) : (
					<span className="conversation-work-step-duration">{formatDurationMs(step.durationMs)}</span>
				))}
			{/* "在数据浏览器打开" — the query jumps to the side pane's data tab where paging/sorting costs zero tokens. */}
			{browse && onOpenDataBrowser && (
				<button
					type="button"
					className="conversation-work-step-browse"
					title={localize('appr.openInBrowserTitle')}
					onClick={event => {
						// The row itself may be an expand toggle — don't trip it.
						event.stopPropagation();
						onOpenDataBrowser(browse);
					}}
				>
					<span className="codicon codicon-database" aria-hidden="true" />
					<span>{localize('appr.openInBrowser')}</span>
				</button>
			)}
			{step.detail && <span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} conversation-work-step-chevron`} aria-hidden="true" />}
		</>
	);

	return (
		<div className={`conversation-work-step ${step.kind}`}>
			{step.detail ? (
				<button type="button" className="conversation-work-step-row" aria-expanded={open} onClick={() => setOpen(!open)}>
					{rowContent}
				</button>
			) : (
				<div className="conversation-work-step-row">{rowContent}</div>
			)}
			{step.detail && open && <pre className="conversation-work-step-detail">{step.detail}</pre>}
		</div>
	);
}

function formatDurationMs(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function thinkingDurationText(ms: number): string {
	return ms < 10_000 ? 'a few seconds' : formatDurationMs(ms);
}
