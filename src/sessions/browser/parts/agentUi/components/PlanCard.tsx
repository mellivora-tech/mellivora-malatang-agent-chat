/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import { buildReviseTurn } from '../../../../services/sessions/common/planArtifact.js';
import type { IObservable } from '../../../../base/common/observable.js';
import type { IPlanArtifact, IPlanComment, IPlanSection, ISessionMessage } from '../../../../services/sessions/common/session.js';
import type { ISessionMessageSender } from '../../conversationView.js';
import { Markdown } from './Markdown.js';
import { useObservable } from '../bridge/useObservable.js';

const PLAN_SECTION_ICONS: Readonly<Record<string, string>> = {
	overview: 'codicon-info',
	files: 'codicon-files',
	approach: 'codicon-lightbulb',
	steps: 'codicon-list-ordered',
	risks: 'codicon-warning',
};

export interface IPlanCardProps {
	readonly message: ISessionMessage;
	readonly sessionId: string | undefined;
	readonly planComments: IObservable<readonly IPlanComment[]> | undefined;
	readonly messageSender: ISessionMessageSender | undefined;
	readonly onFocusComposer: () => void;
}

/**
 * The reviewable plan artifact card (`role:'plan'`): sectioned content with
 * the version in the header. A draft card carries the review actions (按此执行
 * / 让它改); a superseded one collapses to its header. A message whose
 * structured payload is missing falls back to its markdown text.
 *
 * React port of createPlanCard/patchPlanCard/renderPlanCardContent. The old
 * version needed a `planCardsDirty` flag + a `session.planComments.subscribe`
 * on ConversationView, purely to notice "comments changed, message object
 * didn't" and force a resync — this component subscribes to planComments
 * itself (useObservable), so that whole mechanism is gone: it just re-renders
 * on its own when the store fires.
 */
export function PlanCard(props: IPlanCardProps): JSX.Element {
	const { message, sessionId, planComments, messageSender, onFocusComposer } = props;
	const plan = message.plan;
	const superseded = plan?.state === 'superseded';
	const isWalkthrough = plan?.kind === 'walkthrough';

	// A retired version folds to its header by default; the user can reopen it.
	const [manuallyExpanded, setManuallyExpanded] = useState(false);
	const collapsed = superseded && !manuallyExpanded;

	const [submitting, setSubmitting] = useState(false);

	const allComments = useObservable(planComments, []);

	const header = (
		<>
			<span className={`codicon ${isWalkthrough ? 'codicon-book' : 'codicon-checklist'}`} aria-hidden="true" />
			<span className="conversation-plan-title">{plan ? plan.title : localize('plan.title.fallback')}</span>
			{plan &&
				(isWalkthrough ? (
					<span className="conversation-plan-state walkthrough">{localize('plan.tag.walkthrough')}</span>
				) : (
					<>
						<span className="conversation-plan-version">v{plan.version}</span>
						{plan.state !== 'draft' && (
							<span className={`conversation-plan-state ${plan.state}`}>{plan.state === 'approved' ? localize('plan.state.approved') : localize('plan.state.superseded')}</span>
						)}
					</>
				))}
			{superseded && <span className={`codicon ${collapsed ? 'codicon-chevron-right' : 'codicon-chevron-down'} conversation-plan-chevron`} aria-hidden="true" />}
		</>
	);

	return (
		<section className={`conversation-plan${superseded ? ' superseded' : ''}${collapsed ? ' collapsed' : ''}`} data-message-id={message.id}>
			{superseded ? (
				<button type="button" className="conversation-plan-header" onClick={() => setManuallyExpanded(v => !v)}>
					{header}
				</button>
			) : (
				<div className="conversation-plan-header">{header}</div>
			)}

			{!collapsed &&
				(!plan ? (
					<Markdown className="conversation-plan-fallback" text={message.text} />
				) : (
					<PlanBody
						plan={plan}
						allComments={allComments}
						sessionId={sessionId}
						messageSender={messageSender}
						submitting={submitting}
						setSubmitting={setSubmitting}
						onFocusComposer={onFocusComposer}
					/>
				))}
		</section>
	);
}

interface IPlanBodyProps {
	readonly plan: IPlanArtifact;
	readonly allComments: readonly IPlanComment[];
	readonly sessionId: string | undefined;
	readonly messageSender: ISessionMessageSender | undefined;
	readonly submitting: boolean;
	readonly setSubmitting: (value: boolean) => void;
	readonly onFocusComposer: () => void;
}

function PlanBody(props: IPlanBodyProps): JSX.Element {
	const { plan, allComments, sessionId, messageSender, submitting, setSubmitting, onFocusComposer } = props;
	// Comments are version-scoped via section ids; only a draft accepts new ones.
	const commentableSessionId = sessionId;
	const commentable = plan.state === 'draft' && commentableSessionId !== undefined && messageSender?.setPlanComment !== undefined;

	const resolveComment = (comment: IPlanComment) => {
		if (commentableSessionId === undefined || !messageSender?.setPlanComment) {
			return;
		}
		void messageSender.setPlanComment(commentableSessionId, { ...comment, resolved: true });
	};
	const submitComment = (sectionId: string, body: string) => {
		if (commentableSessionId === undefined || !messageSender?.setPlanComment) {
			return;
		}
		void messageSender.setPlanComment(commentableSessionId, {
			id: `${sectionId}-c${Date.now().toString(36)}`,
			planId: plan.id,
			sectionId,
			body,
			resolved: false,
			createdAt: new Date(),
		});
	};

	return (
		<>
			<div className="conversation-plan-sections">
				{plan.sections.map(section => (
					<PlanSectionView
						key={section.id}
						section={section}
						comments={allComments.filter(comment => comment.sectionId === section.id)}
						commentable={commentable}
						onResolveComment={resolveComment}
						onSubmitComment={submitComment}
					/>
				))}
			</div>

			{/* Review actions live only on a draft — an approved or superseded plan is
			settled. Approve flips the SESSION mode (the run reads session.permissionMode)
			and sends the proceed turn; revise focuses the composer so the user says
			what to change. */}
			{plan.state === 'draft' && sessionId && messageSender && (
				<div className="conversation-plan-actions">
					<button
						type="button"
						className="conversation-plan-approve"
						disabled={submitting}
						onClick={() => {
							setSubmitting(true);
							void (async () => {
								await messageSender.setPlanState?.(sessionId, plan.id, 'approved');
								await messageSender.setSessionPermissionMode?.(sessionId, 'auto-edit');
								await messageSender.sendMessage(sessionId, localize('plan.approve.message'));
							})().catch(() => setSubmitting(false));
						}}
					>
						{localize('plan.approve')}
					</button>
					<button
						type="button"
						className="conversation-plan-revise"
						disabled={submitting}
						onClick={() => {
							// With open comments the revise turn writes itself; the model
							// re-proposes and the comments auto-resolve (they were delivered).
							// Without any, the user says what to change in the composer.
							const turn = buildReviseTurn(plan, allComments);
							if (turn === undefined) {
								onFocusComposer();
								return;
							}
							setSubmitting(true);
							void (async () => {
								await messageSender.sendMessage(sessionId, turn);
								// Only after the turn is on its way — a failed send must not
								// leave the comments falsely marked as delivered.
								for (const comment of allComments) {
									if (comment.planId === plan.id && !comment.resolved) {
										await messageSender.setPlanComment?.(sessionId, { ...comment, resolved: true });
									}
								}
							})().catch(() => setSubmitting(false));
						}}
					>
						{localize('plan.revise')}
					</button>
				</div>
			)}
		</>
	);
}

interface IPlanSectionViewProps {
	readonly section: IPlanSection;
	readonly comments: readonly IPlanComment[];
	readonly commentable: boolean;
	readonly onResolveComment: (comment: IPlanComment) => void;
	readonly onSubmitComment: (sectionId: string, body: string) => void;
}

function PlanSectionView(props: IPlanSectionViewProps): JSX.Element {
	const { section, comments, commentable, onResolveComment, onSubmitComment } = props;
	const openCount = comments.filter(comment => !comment.resolved).length;

	const [editorOpen, setEditorOpen] = useState(false);
	const [draft, setDraft] = useState('');
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Replaces the old cross-render `planCommentFocus` flag — this component IS
	// the section for its whole lifetime, so it can just focus itself.
	useEffect(() => {
		if (editorOpen) {
			inputRef.current?.focus();
			inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
		}
	}, [editorOpen]);

	return (
		<div className="conversation-plan-section" data-section-id={section.id}>
			<div className="conversation-plan-kicker">
				<span className={`codicon ${PLAN_SECTION_ICONS[section.kind] ?? 'codicon-circle-small'}`} aria-hidden="true" />
				<span>{section.heading}</span>
				{openCount > 0 && <span className="conversation-plan-comment-badge">💬 {openCount}</span>}
				{commentable && !editorOpen && (
					<button
						type="button"
						className="conversation-plan-gutter codicon codicon-comment-add"
						title={localize('plan.comment.gutter')}
						aria-label={localize('plan.comment.aria', section.heading)}
						onClick={() => setEditorOpen(true)}
					/>
				)}
			</div>

			{section.body.trim() !== '' && <Markdown className="conversation-plan-body" text={section.body} />}

			{section.items !== undefined && section.items.length > 0 && (
				<ul className="conversation-plan-items">
					{section.items.map((item, index) => (
						<li key={index}>{item}</li>
					))}
				</ul>
			)}

			{comments.length > 0 && (
				<div className="conversation-plan-thread">
					{comments.map(comment => (
						<div key={comment.id} className={`conversation-plan-comment${comment.resolved ? ' resolved' : ''}`}>
							<span className="conversation-plan-comment-body">{comment.body}</span>
							{comment.resolved ? (
								<span className="conversation-plan-comment-tag">{localize('plan.comment.resolved')}</span>
							) : (
								commentable && (
									<button type="button" className="conversation-plan-comment-resolve" onClick={() => onResolveComment(comment)}>
										{localize('plan.comment.resolve')}
									</button>
								)
							)}
						</div>
					))}
				</div>
			)}

			{commentable && editorOpen && (
				<div className="conversation-plan-comment-editor">
					<textarea
						ref={inputRef}
						className="conversation-plan-comment-input"
						placeholder={localize('plan.comment.placeholder', section.heading)}
						rows={2}
						value={draft}
						onChange={event => setDraft(event.target.value)}
					/>
					<div className="conversation-plan-comment-buttons">
						<button
							type="button"
							className="conversation-plan-approve"
							onClick={() => {
								const body = draft.trim();
								if (body === '') {
									return;
								}
								setEditorOpen(false);
								setDraft('');
								onSubmitComment(section.id, body);
							}}
						>
							{localize('plan.comment.submit')}
						</button>
						<button
							type="button"
							className="conversation-plan-revise"
							onClick={() => {
								setEditorOpen(false);
								setDraft('');
							}}
						>
							{localize('sidebar.cancel')}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
