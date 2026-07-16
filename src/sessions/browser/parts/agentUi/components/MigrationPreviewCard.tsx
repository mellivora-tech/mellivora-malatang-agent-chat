/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useRef, useState, type JSX } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import {
	applyMappingEdits,
	buildMigrationConfirmTurn,
	buildMigrationReviseTurn,
	buildMigrationSql,
	type IMigrationCellEdit,
	type IMigrationMappingEdit,
	type IMigrationPreviewProps,
} from '../../../../services/sessions/common/uiComponents/migrationPreview.js';
import type { IUiCardProps } from '../registry.js';
import { Markdown } from './Markdown.js';
import { MigrationGrid } from './MigrationGrid.js';

/**
 * The migration_preview card body (UiCard owns the shell/header) — a
 * WORKBENCH, not a confirmation dialog. Three tiers of interaction:
 * Tier 0 in-card: edit sample cells, edit target column names and
 * transformSql inline, drop/restore fields. Tier 1 (IPC, no model): export
 * the locally-compiled migration .sql. Tier 2 (model): confirm — the turn
 * carries the EDITED mappings and the exact compiled SQL so the model
 * executes what the user saw, never a regeneration — or revise.
 *
 * Settled state is per-mount (P1d persists it). Mapping edits invalidate the
 * sample (it was computed by the model against the ORIGINAL mappings) — the
 * stale marker says so instead of letting the grid silently mislead.
 */
export function MigrationPreviewCard(props: IUiCardProps<IMigrationPreviewProps>): JSX.Element {
	const { props: preview, context } = props;
	const { sessionId, messageSender, onFocusComposer, exportText } = context;

	// Last edit per cell wins; a ref, not state — grid callbacks must not
	// re-render the card per keystroke.
	const editsRef = useRef(new Map<string, IMigrationCellEdit>());
	const [dirtyCount, setDirtyCount] = useState(0);
	// Mapping edits DO drive re-renders — the table shows their values.
	const [mappingEdits, setMappingEdits] = useState<ReadonlyMap<number, IMigrationMappingEdit>>(new Map());
	const [submitting, setSubmitting] = useState(false);
	const [settled, setSettled] = useState(false);
	const [exportedPath, setExportedPath] = useState<string | undefined>(undefined);

	const onCellEdited = (edit: IMigrationCellEdit): void => {
		editsRef.current.set(`${edit.row}:${edit.column}`, edit);
		setDirtyCount(editsRef.current.size);
	};

	const patchMapping = (index: number, patch: Partial<IMigrationMappingEdit>): void => {
		const original = preview.mappings[index];
		setMappingEdits(previous => {
			const next = new Map(previous);
			const merged: IMigrationMappingEdit = { index, ...previous.get(index), ...patch };
			// Typing the original value back = no edit; an edit that no longer
			// changes anything is forgotten entirely (restore works the same way).
			const target = merged.target !== undefined && merged.target !== original?.target ? merged.target : undefined;
			const transformSql = merged.transformSql !== undefined && merged.transformSql !== (original?.transformSql ?? '') ? merged.transformSql : undefined;
			if (target === undefined && transformSql === undefined && !merged.dropped) {
				next.delete(index);
			} else {
				next.set(index, {
					index,
					...(target !== undefined ? { target } : {}),
					...(transformSql !== undefined ? { transformSql } : {}),
					...(merged.dropped ? { dropped: true } : {}),
				});
			}
			return next;
		});
	};

	const mappingEditList = [...mappingEdits.values()];
	const mappingsDirty = mappingEditList.length > 0;
	const effectiveMappings = mappingsDirty ? applyMappingEdits(preview.mappings, mappingEditList) : preview.mappings;
	const compiledSql = buildMigrationSql({ ...preview, mappings: effectiveMappings });

	const errors = (preview.validations ?? []).filter(validation => validation.level === 'error').length;
	const warnings = (preview.validations ?? []).length - errors;
	const canAct = !settled && !submitting && sessionId !== undefined && messageSender !== undefined;

	const confirm = (): void => {
		if (!canAct) {
			return;
		}
		setSubmitting(true);
		const turn = buildMigrationConfirmTurn(preview, [...editsRef.current.values()], {
			mappingEdits: mappingEditList,
			...(compiledSql !== undefined ? { compiledSql } : {}),
		});
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

	const exportSql = (): void => {
		if (compiledSql === undefined || exportText === undefined) {
			return;
		}
		const name = `migration-${(preview.targetTable ?? 'target').replaceAll(/[^\w.-]+/g, '-')}.sql`;
		void exportText(name, compiledSql).then(path => {
			if (path !== undefined) {
				setExportedPath(path);
			}
		});
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
						<th>{localize('ui.migration.mapping.sql')}</th>
						<th aria-label={localize('ui.migration.mapping.actions')} />
					</tr>
				</thead>
				<tbody>
					{preview.mappings.map((mapping, index) => {
						const edit = mappingEdits.get(index);
						const dropped = edit?.dropped === true;
						return (
							<tr key={index} className={dropped ? 'migration-mapping-dropped' : undefined}>
								<td>{mapping.source}</td>
								<td>
									<input
										className="migration-mapping-input"
										value={edit?.target ?? mapping.target}
										disabled={settled || dropped}
										onChange={event => patchMapping(index, { target: event.target.value })}
										aria-label={localize('ui.migration.mapping.target')}
									/>
								</td>
								<td>
									{mapping.transform ?? ''}
									{mapping.note !== undefined && mapping.note.trim() !== '' && <span className="migration-mapping-note"> — {mapping.note}</span>}
								</td>
								<td>
									<input
										className="migration-mapping-input migration-mapping-sql"
										value={edit?.transformSql ?? mapping.transformSql ?? ''}
										placeholder={mapping.source}
										disabled={settled || dropped}
										onChange={event => patchMapping(index, { transformSql: event.target.value })}
										aria-label={localize('ui.migration.mapping.sql')}
									/>
								</td>
								<td>
									{!settled && (
										<button
											type="button"
											className="migration-mapping-drop"
											title={dropped ? localize('ui.migration.restore') : localize('ui.migration.drop')}
											onClick={() => patchMapping(index, { dropped: !dropped })}
										>
											<span className={`codicon ${dropped ? 'codicon-discard' : 'codicon-trash'}`} aria-hidden="true" />
										</button>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>

			{preview.sampleRows.length > 0 && (
				<>
					<div className="migration-sample-title">
						{localize('ui.migration.sampleTitle', preview.sampleRows.length, preview.totalRowCount ?? preview.sampleRows.length)}
						{(errors > 0 || warnings > 0) && <span className="migration-issues">{localize('ui.migration.issues', errors, warnings)}</span>}
						{dirtyCount > 0 && <span className="migration-dirty">{localize('ui.migration.dirty', dirtyCount)}</span>}
						{mappingsDirty && <span className="migration-stale">{localize('ui.migration.stale')}</span>}
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
				{compiledSql !== undefined && exportText !== undefined && (
					<button type="button" className="conversation-plan-revise migration-export" disabled={submitting} onClick={exportSql}>
						{localize('ui.migration.export')}
					</button>
				)}
				{exportedPath !== undefined && <span className="migration-exported">{localize('ui.migration.exported', exportedPath)}</span>}
			</div>
		</div>
	);
}
