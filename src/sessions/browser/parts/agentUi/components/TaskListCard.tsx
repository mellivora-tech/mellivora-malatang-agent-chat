/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import type { ISessionMessage } from '../../../../services/sessions/common/session.js';

export interface ITaskListCardProps {
	readonly message: ISessionMessage;
}

/**
 * 计划卡 (2026-08-06, update_plan): the run's task list as a structured
 * artifact — ONE card per run, wholesale-updated, always showing the current
 * state (Claude Code's TodoWrite panel, not a stream of historical rows; the
 * calls themselves leave no work steps). Fold rule is a pure function of the
 * items: all done → collapsed to the one-line conclusion; anything pending or
 * active → expanded, so a failed/interrupted run's stuck item stays in view.
 * A manual toggle always wins.
 */
export function TaskListCard(props: ITaskListCardProps): JSX.Element | null {
	const tasklist = props.message.tasklist;
	const [openOverride, setOpenOverride] = useState<boolean | undefined>(undefined);
	if (tasklist === undefined || tasklist.items.length === 0) {
		return null;
	}

	const items = tasklist.items;
	const done = items.filter(item => item.status === 'done').length;
	const allDone = done === items.length;
	const expanded = openOverride ?? !allDone;

	return (
		<section className={`conversation-tasklist${allDone ? ' done' : ''}`} data-message-id={props.message.id}>
			<button type="button" className="conversation-tasklist-header" aria-expanded={expanded} onClick={() => setOpenOverride(!expanded)}>
				<span className={`codicon ${allDone ? 'codicon-check-all' : 'codicon-checklist'}`} aria-hidden="true" />
				<span className="conversation-tasklist-title">{localize('conv.tasklist.title')}</span>
				<span className="conversation-tasklist-count">{`${done}/${items.length}`}</span>
				<span className="conversation-tasklist-bar" aria-hidden="true">
					<i style={{ width: `${items.length === 0 ? 0 : Math.round((done / items.length) * 100)}%` }} />
				</span>
				{allDone && <span className="conversation-tasklist-done-mark">{localize('conv.tasklist.allDone')}</span>}
				<span className={`codicon ${expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} conversation-tasklist-chevron`} aria-hidden="true" />
			</button>
			{expanded && (
				<div className="conversation-tasklist-items">
					{items.map((item, index) => (
						<div key={index} className={`conversation-tasklist-item ${item.status}`}>
							{item.status === 'active' ? (
								<span className="codicon codicon-loading codicon-modifier-spin conversation-tasklist-box" aria-hidden="true" />
							) : (
								<span className="conversation-tasklist-box" aria-hidden="true">
									{item.status === 'done' ? '✓' : ''}
								</span>
							)}
							<span className="conversation-tasklist-item-text">{item.title}</span>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
