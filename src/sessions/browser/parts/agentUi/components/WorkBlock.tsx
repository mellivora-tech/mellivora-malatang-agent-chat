/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import type { ISessionDataBrowse, ISessionMessage, ISessionWorkStep } from '../../../../services/sessions/common/session.js';
import { buildWorkSections, presentStep, type IWorkAgentGroup, type WorkRenderItem } from './workRender.js';

export interface IWorkBlockProps {
	readonly message: ISessionMessage;
	readonly onOpenDataBrowser?: ((browse: ISessionDataBrowse) => void) | undefined;
}

/**
 * "Worked for 16m 56s ⌄" — one collapsible block per agent run (#14 Q1: 块内
 * 直播 + 完成收口). Live runs render expanded with sections streaming in;
 * successful completion auto-collapses to one line; FAILED runs stay open
 * with their evidence (outcome === 'error' blocks the tuck-away). A manual
 * expand/collapse always wins over the automatic behavior (expandOverride).
 *
 * Content renders through buildWorkSections: narration steps become section
 * headers ("说一段 → 做一组"), parallel children de-interleave into per-agent
 * sub-blocks, main-loop read sweeps fold into rollups — all pure functions of
 * persisted step facts, so replay matches the live run.
 */
export function WorkBlock(props: IWorkBlockProps): JSX.Element {
	const { message, onOpenDataBrowser } = props;
	const live = message.durationMs === undefined;
	const failed = message.outcome === 'error';

	// Anchor for the live "worked for Ns" ticker — set once, the first time this
	// row is seen live. A ref write during render is intentional here (the
	// React-recommended pattern for "compute once, on the render that first
	// needs it") — there is no effect that could run before the first paint.
	const firstSeenRef = useRef<number | undefined>(undefined);
	if (live && firstSeenRef.current === undefined) {
		firstSeenRef.current = Date.now();
	}

	// undefined = no manual override, follow the automatic rule (open while
	// running or failed, closed after a clean completion). Once the user
	// clicks, their choice sticks regardless of state.
	const [expandOverride, setExpandOverride] = useState<boolean | undefined>(undefined);
	const expanded = expandOverride ?? (live || failed);

	// 收口滚动锚定: when the auto-collapse fires (live → done, no override, not
	// failed) and the block's head has scrolled above the viewport, anchor back
	// to it — the transcript must not yank away from under the reader.
	const rootRef = useRef<HTMLElement | null>(null);
	const wasLiveRef = useRef(live);
	useEffect(() => {
		if (wasLiveRef.current && !live && !failed && expandOverride === undefined) {
			const root = rootRef.current;
			if (root && root.getBoundingClientRect().top < 0) {
				root.scrollIntoView({ block: 'start' });
			}
		}
		wasLiveRef.current = live;
	}, [live, failed, expandOverride]);

	const title = failed && !live ? localize('conv.workInterrupted') : live ? localize('conv.workingFor', formatDurationMs(Date.now() - (firstSeenRef.current ?? Date.now()))) : localize('conv.workedFor', formatDurationMs(message.durationMs ?? 0));

	const sections = buildWorkSections(message.steps ?? []);
	const stepCount = (message.steps ?? []).length;

	return (
		<section ref={rootRef} className={`conversation-work${live ? ' live' : ''}${failed ? ' failed' : ''}`} data-message-id={message.id}>
			<button type="button" className="conversation-work-header" aria-expanded={expanded} onClick={() => setExpandOverride(!expanded)}>
				{live && <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />}
				{failed && !live && <span className="codicon codicon-error" aria-hidden="true" />}
				<span className="conversation-work-title">{title}</span>
				{failed && !live && <span className="conversation-work-meta">{formatDurationMs(message.durationMs ?? 0)}</span>}
				{!live && <span className="conversation-work-meta">{localize('conv.workSteps', String(stepCount))}</span>}
				<span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'}`} aria-hidden="true" />
			</button>
			<div className="conversation-work-steps" hidden={!expanded}>
				{sections.map(section => (
					<div key={`${message.id}:s${section.firstIndex}`} className="conversation-work-section">
						{section.title !== undefined && <SectionHeader title={section.title} detail={section.titleDetail} />}
						<div className={section.title !== undefined ? 'conversation-work-section-body' : undefined}>
							{section.items.map(item =>
								item.kind === 'agentGroup' ? (
									<AgentGroupRow key={`${message.id}:a${item.firstIndex}`} group={item} messageId={message.id} onOpenDataBrowser={onOpenDataBrowser} />
								) : item.kind === 'rollup' ? (
									<RollupRow key={`${message.id}:r${item.steps[0]!.index}`} item={item} messageId={message.id} onOpenDataBrowser={onOpenDataBrowser} />
								) : (
									<WorkStepRow key={`${message.id}:${item.index}`} step={item.step} onOpenDataBrowser={onOpenDataBrowser} />
								),
							)}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}

/** "▸ 环境齐全，开始搭建项目" — the narration promoted to a chapter heading; truncated narrations expand to the full text. */
function SectionHeader(props: { readonly title: string; readonly detail?: string | undefined }): JSX.Element {
	const [open, setOpen] = useState(false);
	if (props.detail === undefined) {
		return <div className="conversation-work-section-head">{props.title}</div>;
	}
	return (
		<>
			<button type="button" className="conversation-work-section-head expandable" aria-expanded={open} onClick={() => setOpen(!open)}>
				{props.title}
			</button>
			{open && <pre className="conversation-work-step-detail">{props.detail}</pre>}
		</>
	);
}

interface IAgentGroupRowProps {
	readonly group: IWorkAgentGroup;
	readonly messageId: string;
	readonly onOpenDataBrowser?: ((browse: ISessionDataBrowse) => void) | undefined;
}

/** "⑃ Explore the renderer workbench… · 4m 43s ⌄" — one child loop, de-interleaved; open while running, tucked when done. */
function AgentGroupRow(props: IAgentGroupRowProps): JSX.Element {
	const { group, messageId, onOpenDataBrowser } = props;
	const [openOverride, setOpenOverride] = useState<boolean | undefined>(undefined);
	const open = openOverride ?? (group.running || group.error);

	return (
		<div className={`conversation-work-agent${group.error ? ' error' : ''}`}>
			<button
				type="button"
				className="conversation-work-step-row conversation-work-agent-row"
				aria-expanded={open}
				{...(group.fullLabel !== undefined && group.fullLabel !== group.label ? { title: group.fullLabel } : {})}
				onClick={() => setOpenOverride(!open)}
			>
				<span className={`codicon ${group.error ? 'codicon-error' : 'codicon-type-hierarchy-sub'}`} aria-hidden="true" />
				<span className="conversation-work-step-label">{group.label}</span>
				{group.running ? (
					<span className="codicon codicon-loading codicon-modifier-spin conversation-work-step-duration" aria-label={localize('conv.running')} />
				) : (
					group.durationMs !== undefined && <span className="conversation-work-step-duration">{formatDurationMs(group.durationMs)}</span>
				)}
				<span className={`codicon ${open ? 'codicon-chevron-down' : 'codicon-chevron-right'} conversation-work-step-chevron`} aria-hidden="true" />
			</button>
			{open && (
				<div className="conversation-work-agent-steps">
					{group.items.map(item =>
						item.kind === 'rollup' ? (
							<RollupRow key={`${messageId}:${group.agent}:r${item.steps[0]!.index}`} item={item} messageId={`${messageId}:${group.agent}`} onOpenDataBrowser={onOpenDataBrowser} />
						) : (
							<WorkStepRow key={`${messageId}:${group.agent}:${item.index}`} step={item.step} onOpenDataBrowser={onOpenDataBrowser} />
						),
					)}
					{group.endDetail !== undefined && <div className="conversation-work-agent-stats">{group.endDetail}</div>}
				</div>
			)}
		</div>
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
	const presentation = presentStep(step);
	// Failed steps open by default — a failed run's evidence must be in view
	// without a hunt (#14 Q1); everything else starts collapsed.
	const [open, setOpen] = useState(() => presentation.error && step.detail !== undefined);
	const browse = step.browse;

	// 思考直播: the CURRENT thinking stretch streams its tail in a clamped
	// window; closeStep collapses it into the "思考了 Ns" summary row below.
	if (step.kind === 'thinking' && step.running === true) {
		return (
			<div className="conversation-work-step thinking live">
				<div className="conversation-work-step-row">
					<span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
					<span className="conversation-work-step-label">{localize('conv.thinking')}</span>
				</div>
				{step.detail !== undefined && <div className="conversation-work-thinking-stream">{step.detail}</div>}
			</div>
		);
	}

	// 子代理直播行: the running spawn synthetic's LABEL carries the child's
	// current activity (⑃ grep … / 撰写结论中 · 3.4k 字) — the facts path would
	// flatten it to "Spawn <task>" and swallow the whole liveness signal
	// (subagent_tool/subagent_progress), so it renders label-first.
	if (step.kind === 'tool' && step.running === true && step.tool === 'spawn_agent') {
		return (
			<div className="conversation-work-step tool">
				<div className="conversation-work-step-row">
					<span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
					<span className="conversation-work-step-label">{step.label}</span>
				</div>
			</div>
		);
	}

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
