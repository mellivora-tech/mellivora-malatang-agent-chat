/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import type { IExportTextMeta } from '../../../../services/dataFiles/common/dataFiles.js';
import type { ISessionMessage } from '../../../../services/sessions/common/session.js';
import type { ISessionMessageSender } from '../../conversationView.js';
import { resolveUiComponent, type IUiCardContext } from '../registry.js';
import { Markdown } from './Markdown.js';

export interface IUiCardHostProps {
	readonly message: ISessionMessage;
	readonly sessionId: string | undefined;
	readonly messageSender: ISessionMessageSender | undefined;
	readonly onFocusComposer: () => void;
	readonly exportText?: ((defaultName: string, content: string, meta?: IExportTextMeta) => Promise<string | undefined>) | undefined;
	readonly openSurface?: (() => void) | undefined;
}

/**
 * The generic card host for `role:'ui'` messages: resolves the message's
 * component through the registry and renders it, or falls back to the
 * message's markdown text whenever anything about the envelope doesn't line
 * up — missing payload, unregistered component name (an older build reading a
 * newer session), or props that fail the component's own parser. The fallback
 * is the same content the model reads back in the next turn, so a degraded
 * card is still a truthful one.
 */
export function UiCard(props: IUiCardHostProps): JSX.Element {
	const { message, sessionId, messageSender, onFocusComposer, exportText, openSurface } = props;
	const ui = message.ui;

	const entry = ui ? resolveUiComponent(ui.component) : undefined;
	const parsed = ui !== undefined && entry !== undefined ? entry.parseProps(ui.props) : undefined;

	if (ui === undefined || entry === undefined || parsed === undefined) {
		return (
			<section className="conversation-ui" data-message-id={message.id}>
				<div className="conversation-ui-header">
					<span className="codicon codicon-layout" aria-hidden="true" />
					<span className="conversation-ui-title">{ui ? ui.title : localize('ui.title.fallback')}</span>
				</div>
				<Markdown className="conversation-ui-fallback" text={message.text} />
			</section>
		);
	}

	const context: IUiCardContext = { sessionId, messageSender, onFocusComposer, exportText, openSurface };
	const Component = entry.Component;
	return (
		<section className="conversation-ui" data-message-id={message.id}>
			<div className="conversation-ui-header">
				<span className="codicon codicon-layout" aria-hidden="true" />
				<span className="conversation-ui-title">{ui.title}</span>
			</div>
			<Component message={message} props={parsed} context={context} />
		</section>
	);
}
