/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import type { ISessionDataBrowse, ISessionMessage, ISessionWorkStep } from '../../../../services/sessions/common/session.js';
import { buildWorkRenderItems, presentStep, type WorkRenderItem } from './workRender.js';

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
 *
 * Steps render through buildWorkRenderItems (#14 P0): consecutive read-class
 * calls fold into one "探索了 X 个文件…" rollup row, tool rows show intent
 * verbs + argument chips derived from persisted step facts — pure functions
 * of the stored data, so replay renders identically to the live run.
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

	const items = buildWorkRenderItems(message.steps ?? []);

	return (
		<section className={`conversation-work${live ? ' live' : ''}`} data-message-id={message.id}>
			<button type="button" className="conversation-work-header" aria-expanded={expanded} onClick={() => setExpandOverride(!expanded)}>
				{live && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}
				<span className="conversation-work-title">{title}</span>
				<span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} aria-hidden="true" />
			</button>
			<div className="conversation-work-steps" hidden={!expanded}>
				{items.map(item =>
					item.kind === 'rollup' ? (
						<RollupRow key={`${message.id}:r${item.steps[0]!.index}`} item={item} messageId={message.id} onOpenDataBrowser={onOpenDataBrowser} />
					) : (
						<WorkStepRow key={`${message.id}:${item.index}`} step={item.step} onOpenDataBrowser={onOpenDataBrowser} />
					)
				)}
			</div>
		</section>
	);
}

interface IRollupRowProps {
	readonly item: Extract<WorkRenderItem, { kind: 'rollup' }>;
	readonly messageId: string;
	readonly onOpenDataBrowser?: ((browse: ISessionDataBrowse) => void) | undefined;
}

/** "🔍 探索了 8 个文件、2 个目录 · 3 次检索 · 12s ⌄" — expands to the folded read steps. */
function RollupRow(props: IRollupRowProps): JSX.Element {
	const { item, messageId, onOpenDataBrowser } = props;
	const [open, setOpen] = useState(false);

	const parts: string[] = [];
	if (item.files > 0) {
		parts.push(localize('conv.rollup.files', String(item.files)));
	}
	if (item.dirs > 0) {
		parts.push(localize('conv.rollup.dirs', String(item.dirs)));
	}
	const summary = localize('conv.rollup.explored', parts.join(localize('conv.rollup.sep')));
	const searches = item.searches > 0 ? localize('conv.rollup.searches', String(item.searches)) : undefined;

	return (
		<div className="conversation-work-rollup">
			<button type="button" className="conversation-work-step-row conversation-work-rollup-row" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="codicon codicon-search" aria-hidden="true" />
				<span className="conversation-work-step-label">
					{parts.length > 0 ? summary : (searches ?? '')}
					{parts.length > 0 && searches ? ` · ${searches}` : ''}
				</span>
				{item.running ? (
					<span className="codicon codicon-loading codicon-modifier-spin conversation-work-step-duration" aria-label={localize('conv.running')} />
				) : (
					<span className="conversation-work-step-duration">{formatDurationMs(item.durationMs)}</span>
				)}
				<span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} conversation-work-step-chevron`} aria-hidden="true" />
			</button>
			{open && (
				<div className="conversation-work-rollup-steps">
					{item.steps.map(member => (
						<WorkStepRow key={`${messageId}:${member.index}`} step={member.step} onOpenDataBrowser={onOpenDataBrowser} />
					))}
				</div>
			)}
		</div>
	);
}

interface IWorkStepRowProps {
	readonly step: ISessionWorkStep;
	readonly onOpenDataBrowser?: ((browse: ISessionDataBrowse) => void) | undefined;
}

/** "读取 ▸src/a.ts · 2s" (structured facts) / "🔧 read_file src/a.ts · 2s" (legacy label) — tool steps expand to their output. */
function WorkStepRow(props: IWorkStepRowProps): JSX.Element {
	const { step, onOpenDataBrowser } = props;
	// Keyed by the parent's `key`, not a messageId:index Set entry (the old
	// stepExpand Set existed only because the DOM version rebuilt every step
	// row from scratch on every patch) — React's keyed reconciliation already
	// keeps this instance, and its state, alive across re-renders.
	const [open, setOpen] = useState(false);
	const browse = step.browse;
	const presentation = presentStep(step);

	const icon =
		step.kind === 'thinking'
			? 'codicon-history'
			: step.kind === 'narration'
				? 'codicon-comment'
				: presentation.error
					? 'codicon-error'
					: 'codicon-tools';

	const rowContent = (
		<>
			<span className={`codicon ${icon}`} aria-hidden="true" />
			{step.kind === 'tool' && presentation.verbKey !== undefined ? (
				<span className="conversation-work-step-label">
					<span className="conversation-work-step-verb">{`${presentation.sub ? '⑃ ' : ''}${localize(presentation.verbKey)}`}</span>
					{presentation.chip !== undefined && <span className="conversation-work-step-chip">{presentation.chip}</span>}
				</span>
			) : (
				<span className="conversation-work-step-label">{step.kind === 'thinking' ? localize('conv.thoughtFor', thinkingDurationText(step.durationMs)) : step.label}</span>
			)}
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
		<div className={`conversation-work-step ${step.kind}${presentation.error ? ' error' : ''}`}>
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
