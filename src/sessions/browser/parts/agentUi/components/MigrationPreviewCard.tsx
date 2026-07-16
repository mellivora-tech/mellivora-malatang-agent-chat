/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import {
	buildMigrationConfirmTurn,
	buildMigrationReviseTurn,
	type IMigrationCellEdit,
	type IMigrationPreviewProps,
} from '../../../../services/sessions/common/uiComponents/migrationPreview.js';
import type { IUiCardProps } from '../registry.js';
import { Markdown } from './Markdown.js';
import { MigrationGrid } from './MigrationGrid.js';

/**
 * The migration_preview card body (UiCard owns the shell/header): mapping
 * table, editable sample grid, validation summary, confirm/revise actions —
 * the same review loop as PlanCard, with cell corrections instead of section
 * comments. Confirm/settled state is per-mount only (P0 known limitation: a
 * reload re-offers the actions; a persisted uiState overlay is P1). Unlike
 * plan-approve there is NO permission-mode flip here — execute_data_source is
 * approval-gated per statement regardless of mode, and that is the point.
 */
export function MigrationPreviewCard(props: IUiCardProps<IMigrationPreviewProps>): JSX.Element {
	const { props: preview, context } = props;
	const { sessionId, messageSender, onFocusComposer } = context;

	// Last edit per cell wins; editing back to the original still counts as an
	// edit (the user touched it deliberately — the turn shows before === after
	// only if they typed the identical value back, which is harmless). A ref,
	// not state: grid callbacks must not re-render the card per keystroke.
	const editsRef = useRef(new Map<string, IMigrationCellEdit>());
	const [dirtyCount, setDirtyCount] = useState(0);
	const [submitting, setSubmitting] = useState(false);
	const [settled, setSettled] = useState(false);

	const onCellEdited = (edit: IMigrationCellEdit): void => {
		editsRef.current.set(`${edit.row}:${edit.column}`, edit);
		setDirtyCount(editsRef.current.size);
	};

	const errors = (preview.validations ?? []).filter(validation => validation.level === 'error').length;
	const warnings = (preview.validations ?? []).length - errors;
	const canAct = !settled && !submitting && sessionId !== undefined && messageSender !== undefined;

	const confirm = (): void => {
		if (!canAct) {
			return;
		}
		setSubmitting(true);
		const turn = buildMigrationConfirmTurn(preview, [...editsRef.current.values()]);
		void messageSender
			.sendMessage(sessionId, turn)
			.then(() => setSettled(true))
			.finally(() => setSubmitting(false));
	};

	const revise = (): void => {
		if (!canAct) {
			return;
		}
		const turn = buildMigrationReviseTurn(preview, [...editsRef.current.values()]);
		if (turn === undefined) {
			// Nothing structured to say — the user types what to change instead.
			onFocusComposer();
			return;
		}
		setSubmitting(true);
		void messageSender.sendMessage(sessionId, turn).finally(() => setSubmitting(false));
	};

	return (
		<div className="conversation-ui-migration">
			<div className="migration-endpoints">
				<span className="migration-endpoint">{preview.sourceLabel}</span>
				<span className="codicon codicon-arrow-right" aria-hidden="true" />
				<span className="migration-endpoint">{preview.targetLabel}</span>
			</div>

			<table className="migration-mappings">
				<thead>
					<tr>
						<th>{localize('ui.migration.mapping.source')}</th>
						<th>{localize('ui.migration.mapping.target')}</th>
						<th>{localize('ui.migration.mapping.transform')}</th>
					</tr>
				</thead>
				<tbody>
					{preview.mappings.map((mapping, index) => (
						<tr key={index}>
							<td>{mapping.source}</td>
							<td>{mapping.target}</td>
							<td>
								{mapping.transform ?? ''}
								{mapping.note !== undefined && mapping.note.trim() !== '' && <span className="migration-mapping-note"> — {mapping.note}</span>}
							</td>
						</tr>
					))}
				</tbody>
			</table>

			{preview.sampleRows.length > 0 && (
				<>
					<div className="migration-sample-title">
						{localize('ui.migration.sampleTitle', preview.sampleRows.length, preview.totalRowCount ?? preview.sampleRows.length)}
						{(errors > 0 || warnings > 0) && <span className="migration-issues">{localize('ui.migration.issues', errors, warnings)}</span>}
						{dirtyCount > 0 && <span className="migration-dirty">{localize('ui.migration.dirty', dirtyCount)}</span>}
					</div>
					<MigrationGrid columns={preview.columns} sampleRows={preview.sampleRows} validations={preview.validations ?? []} readOnly={settled} onCellEdited={onCellEdited} />
				</>
			)}

			{preview.note !== undefined && preview.note.trim() !== '' && <Markdown className="migration-note" text={preview.note} />}

			<div className="conversation-plan-actions">
				{settled ? (
					<span className="migration-settled">{localize('ui.migration.settled')}</span>
				) : (
					<>
						<button type="button" className="conversation-plan-approve" disabled={!canAct} onClick={confirm}>
							{localize('ui.migration.confirm')}
						</button>
						<button type="button" className="conversation-plan-revise" disabled={!canAct} onClick={revise}>
							{localize('ui.migration.revise')}
						</button>
					</>
				)}
			</div>
		</div>
	);
}
