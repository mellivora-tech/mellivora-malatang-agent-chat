/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import { DOCUMENT_SPLIT_MARKER } from '../../../../services/sessions/common/session.js';
import type { ISessionAttachment, ISessionMessage } from '../../../../services/sessions/common/session.js';
import type { IMessageActions } from '../../conversationView.js';
import { Markdown } from './Markdown.js';

export interface IMessageRowProps {
	readonly message: ISessionMessage;
	readonly actions?: IMessageActions | undefined;
	readonly resolveImage?: ((path: string) => Promise<string | undefined>) | undefined;
	readonly resolveDocument?: ((path: string) => Promise<string | undefined>) | undefined;
}

/**
 * React port of createMessageRow/patchRow for the user/assistant/tool rows.
 * The old DOM version hand-split "create once" (avatar, label, attachments,
 * action bar) from "patch every message-identity change" (text, tool detail,
 * feedback state) because a full rebuild would restart hover-revealed UI and
 * re-run the collapse measurement pointlessly. Re-rendering the whole
 * component and letting React diff achieves the same thing for free — DOM
 * nodes React can prove are unchanged (stable JSX shape, same keys) are left
 * alone, so the action bar's hover-fade and the collapse state survive a
 * streamed token exactly as before.
 */
export function MessageRow(props: IMessageRowProps): JSX.Element {
	const { message, actions, resolveImage, resolveDocument } = props;
	const documentAttachments = message.role === 'assistant' ? (message.attachments ?? []).filter(attachment => attachment.kind === 'document') : [];

	return (
		<article className={`conversation-message ${message.role}`} data-role={message.role} data-message-id={message.id}>
			{message.role !== 'assistant' && (
				<div className="conversation-message-avatar">
					<span className={`codicon ${messageIcon(message.role)}`} aria-hidden="true" />
				</div>
			)}
			<div className="conversation-message-body">
				{message.role !== 'assistant' && <div className="conversation-message-label">{messageLabel(message.role)}</div>}

				{message.role === 'user' ? (
					<UserContent message={message} resolveImage={resolveImage} />
				) : message.role === 'assistant' ? (
					<AssistantText message={message} />
				) : (
					<div className="conversation-message-text">{message.text}</div>
				)}

				{documentAttachments.map((attachment, index) => (
					<DocumentCard key={`${attachment.path}-${index}`} attachment={attachment} resolveDocument={resolveDocument} />
				))}

				{message.detail && <div className="conversation-tool-detail">{message.detail}</div>}

				{actions && <MessageActionBar message={message} actions={actions} />}
			</div>
		</article>
	);
}

/**
 * 播报封口 (2026-08-06 B 方案): the body holds only the run's UNSEALED text
 * stretch — narration seals into the work block as it happens, so what
 * remains here is the answer. While a run's tools execute, every stretch so
 * far has sealed and the body is empty. The split marker tail is transcript
 * wire format (the next run's model reads it) — the human gets the document
 * card instead.
 */
function AssistantText(props: { readonly message: ISessionMessage }): JSX.Element | null {
	const { message } = props;
	if (message.text.trim() === '') {
		return null;
	}
	return <Markdown className="conversation-message-text" text={message.text.replace(DOCUMENT_SPLIT_MARKER, '')} />;
}

interface IDocumentCardProps {
	readonly attachment: ISessionAttachment;
	readonly resolveDocument?: ((path: string) => Promise<string | undefined>) | undefined;
}

/**
 * The generic artifact reference card for a split long answer (#13, Q4): the
 * document's title plus an in-place full-text toggle. Deliberately NOT a
 * PlanCard-style dedicated card — one light, kind-agnostic projection. The
 * markdown loads lazily on first expand and is cached for the row's lifetime;
 * a missing file (deleted media) degrades to a stale note, never an error.
 */
function DocumentCard(props: IDocumentCardProps): JSX.Element {
	const { attachment, resolveDocument } = props;
	const [expanded, setExpanded] = useState(false);
	const [content, setContent] = useState<string | undefined>(undefined);
	const [missing, setMissing] = useState(false);

	useEffect(() => {
		if (!expanded || content !== undefined || missing) {
			return;
		}
		let cancelled = false;
		void (resolveDocument ? resolveDocument(attachment.path) : Promise.resolve(undefined)).then(text => {
			if (cancelled) {
				return;
			}
			if (text !== undefined) {
				setContent(text);
			} else {
				setMissing(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [expanded, content, missing, attachment.path, resolveDocument]);

	const title = attachment.label ?? attachment.path.split('/').pop() ?? attachment.path;
	return (
		<div className="conversation-document-card" data-document-path={attachment.path}>
			<div className="conversation-document-header">
				<span className="codicon codicon-file-text" aria-hidden="true" />
				<span className="conversation-document-title" title={title}>
					{title}
				</span>
				<button type="button" className="conversation-document-toggle" onClick={() => setExpanded(previous => !previous)}>
					{expanded ? localize('conv.docCollapse') : localize('conv.docExpand')}
				</button>
			</div>
			{expanded &&
				(missing ? (
					<div className="conversation-document-missing">{localize('conv.docMissing')}</div>
				) : content !== undefined ? (
					<Markdown className="conversation-document-body" text={content} />
				) : (
					<div className="conversation-document-loading">{localize('conv.docLoading')}</div>
				))}
		</div>
	);
}

interface IUserContentProps {
	readonly message: ISessionMessage;
	readonly resolveImage?: ((path: string) => Promise<string | undefined>) | undefined;
}

function UserContent(props: IUserContentProps): JSX.Element {
	const { message, resolveImage } = props;
	const bubbleRef = useRef<HTMLDivElement>(null);
	const collapse = useBubbleCollapse(bubbleRef, message.text);

	return (
		<>
			{/* An image-only message has no text — don't render an empty bubble. */}
			<div ref={bubbleRef} className="conversation-message-bubble" hidden={message.text.trim() === ''} data-collapse={collapse.state} onClick={collapse.onClick}>
				{message.text}
			</div>
			{message.attachments && message.attachments.length > 0 && (
				<div className="conversation-message-attachments">
					{message.attachments.map((attachment, index) => (
						<AttachmentChip key={index} attachment={attachment} resolveImage={resolveImage} />
					))}
				</div>
			)}
		</>
	);
}

interface IAttachmentChipProps {
	readonly attachment: ISessionAttachment;
	readonly resolveImage?: ((path: string) => Promise<string | undefined>) | undefined;
}

function AttachmentChip(props: IAttachmentChipProps): JSX.Element | null {
	const { attachment, resolveImage } = props;
	// The bytes live on disk — hydrate the thumbnail when they arrive; if
	// resolution comes back empty the chip drops itself (deleted/inaccessible).
	const [imageUrl, setImageUrl] = useState<string | undefined>(undefined);
	const [imageMissing, setImageMissing] = useState(false);

	useEffect(() => {
		if (attachment.kind !== 'image') {
			return;
		}
		let cancelled = false;
		void resolveImage?.(attachment.path).then(url => {
			if (cancelled) {
				return;
			}
			if (url) {
				setImageUrl(url);
			} else {
				setImageMissing(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [attachment, resolveImage]);

	if (attachment.kind === 'image') {
		if (imageMissing) {
			return null;
		}
		return (
			<span className="conversation-message-image">
				<img alt="Attached image" src={imageUrl} />
			</span>
		);
	}

	const name =
		attachment.kind === 'skill'
			? `$${attachment.path}`
			: attachment.kind === 'session'
				? (attachment.label ?? attachment.path)
				: attachment.path.split('/').pop()! + (attachment.kind === 'folder' ? '/' : '');
	return (
		<span className="conversation-message-attachment" title={attachment.path}>
			<span
				className={`codicon ${attachment.kind === 'folder' ? 'codicon-folder' : attachment.kind === 'skill' ? 'codicon-lightbulb' : attachment.kind === 'session' ? 'codicon-comment-discussion' : 'codicon-file'}`}
				aria-hidden="true"
			/>
			<span>{name}</span>
		</span>
	);
}

/**
 * Long pastes start clamped to the composer's own input height; short ones
 * render at their natural height with no click affordance at all. Whether a
 * bubble clips only shows up after layout, so this measures on the next
 * frame and only then decides — same timing as the old measureUserBubbleCollapse,
 * just re-triggered by a text change instead of a manual patch call.
 */
function useBubbleCollapse(bubbleRef: RefObject<HTMLDivElement | null>, text: string): { state: 'collapsed' | 'expanded' | undefined; onClick: () => void } {
	const [state, setState] = useState<'collapsed' | 'expanded' | undefined>(undefined);
	const [collapsible, setCollapsible] = useState(false);

	useLayoutEffect(() => {
		const bubble = bubbleRef.current;
		if (!bubble || text.trim() === '') {
			setState(undefined);
			setCollapsible(false);
			return;
		}
		// Synchronous state commit via useLayoutEffect so the data-collapse
		// attribute is already on the DOM when the rAF below measures height.
		setState('collapsed');
		setCollapsible(false);
		const raf = requestAnimationFrame(() => {
			if (!bubble.isConnected) {
				return;
			}
			if (bubble.scrollHeight > bubble.clientHeight) {
				setCollapsible(true);
			} else {
				setState(undefined);
			}
		});
		return () => cancelAnimationFrame(raf);
		// Deliberately keyed on `text` alone — re-measure on new content, not on every collapse/expand click.
	}, [text]);

	return {
		state,
		onClick: () => {
			if (!collapsible) {
				return;
			}
			// A click that ends a text-drag selection shouldn't also toggle the bubble.
			if (window.getSelection()?.toString()) {
				return;
			}
			setState(previous => (previous === 'expanded' ? 'collapsed' : 'expanded'));
		},
	};
}

interface IMessageActionBarProps {
	readonly message: ISessionMessage;
	readonly actions: IMessageActions;
}

/** Hover action bar: copy, like/dislike (assistant), fork-from-here. */
function MessageActionBar(props: IMessageActionBarProps): JSX.Element {
	const { message, actions } = props;
	return (
		<div className="conversation-message-actions">
			<button type="button" className="conversation-message-action" title="Copy" aria-label="Copy" onClick={() => actions.copy()}>
				<span className="codicon codicon-copy" aria-hidden="true" />
			</button>
			{actions.feedback && (
				<>
					<button
						type="button"
						className={`conversation-message-action${message.feedback === 'like' ? ' active' : ''}`}
						title={message.feedback === 'like' ? 'Remove like' : 'Like'}
						aria-label={message.feedback === 'like' ? 'Remove like' : 'Like'}
						data-feedback="like"
						onClick={() => actions.feedback!('like')}
					>
						<span className="codicon codicon-thumbsup" aria-hidden="true" />
					</button>
					<button
						type="button"
						className={`conversation-message-action${message.feedback === 'dislike' ? ' active' : ''}`}
						title={message.feedback === 'dislike' ? 'Remove dislike' : 'Dislike'}
						aria-label={message.feedback === 'dislike' ? 'Remove dislike' : 'Dislike'}
						data-feedback="dislike"
						onClick={() => actions.feedback!('dislike')}
					>
						<span className="codicon codicon-thumbsdown" aria-hidden="true" />
					</button>
				</>
			)}
			{actions.fork && (
				<button
					type="button"
					className="conversation-message-action"
					title={localize('conv.forkFromHere')}
					aria-label={localize('conv.forkFromHere')}
					onClick={() => actions.fork!()}
				>
					<span className="codicon codicon-git-branch" aria-hidden="true" />
				</button>
			)}
			{message.timestamp && (
				<span className="conversation-message-time" title={message.timestamp.toLocaleString()}>
					{formatMessageTime(message.timestamp)}
				</span>
			)}
		</div>
	);
}

/** "Today 14:23" / "Yesterday 09:05" / "Jul 6 18:30" — always 24-hour. */
function formatMessageTime(date: Date): string {
	const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfYesterday = startOfToday - 86_400_000;
	if (date.getTime() >= startOfToday) {
		return `Today ${time}`;
	}
	if (date.getTime() >= startOfYesterday) {
		return `Yesterday ${time}`;
	}
	return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

function messageIcon(role: ISessionMessage['role']): string {
	switch (role) {
		case 'user':
			return 'codicon-account';
		case 'assistant':
			return 'codicon-copilot';
		case 'tool':
		case 'work':
		case 'digest':
			return 'codicon-tools';
		case 'plan':
			return 'codicon-checklist';
		case 'ui':
			return 'codicon-layout';
	}
}

function messageLabel(role: ISessionMessage['role']): string {
	switch (role) {
		case 'user':
			return 'You';
		case 'assistant':
			return 'Mellivora';
		case 'tool':
		case 'work':
		case 'digest':
			return 'Tool';
		case 'plan':
			return 'Plan';
		case 'ui':
			return 'Mellivora';
	}
}
