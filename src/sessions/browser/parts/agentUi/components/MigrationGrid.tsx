/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// NO tabulator css import here: dataBrowserView.ts already bundles it into
// this same renderer window, and a .css import would break every bare-node
// unit test that transitively reaches this module (conversationView → UiCard
// → registry → here).
import { useEffect, useRef, type JSX } from 'react';
import { TabulatorFull, type CellComponent, type ColumnDefinition } from 'tabulator-tables';
import type { IMigrationCellEdit, IMigrationValidation, MigrationCell } from '../../../../services/sessions/common/uiComponents/migrationPreview.js';

export interface IMigrationGridProps {
	readonly columns: readonly string[];
	readonly sampleRows: readonly (readonly MigrationCell[])[];
	readonly validations: readonly IMigrationValidation[];
	readonly readOnly: boolean;
	readonly onCellEdited: (edit: IMigrationCellEdit) => void;
}

/**
 * The editable sample grid — Tabulator mounted imperatively inside React (the
 * Markdown.tsx bridge precedent; init options follow dataBrowserView's grid,
 * EXCEPT height: a transcript row has no fixed-height parent, so '100%' would
 * collapse to 0 — maxHeight lets ≤~10 rows size naturally and 50 scroll
 * internally). The grid is stateless: edits are reported up and live in the
 * parent card, so a rebuild (props identity change) never loses user input
 * that the parent already collected.
 */
export function MigrationGrid(props: IMigrationGridProps): JSX.Element {
	const { columns, sampleRows, validations, readOnly, onCellEdited } = props;
	const hostRef = useRef<HTMLDivElement>(null);
	// The latest callback, without making it an effect dependency — a parent
	// re-render must not rebuild the grid (and wipe Tabulator-internal focus).
	const onCellEditedRef = useRef(onCellEdited);
	onCellEditedRef.current = onCellEdited;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}

		const issueByCell = new Map<string, IMigrationValidation>();
		for (const validation of validations) {
			issueByCell.set(`${validation.row}:${validation.column}`, validation);
		}

		const data = sampleRows.map((row, rowIndex) => ({ __row: rowIndex, ...Object.fromEntries(row.map((value, index) => [`c${index}`, value])) }));
		const definitions: ColumnDefinition[] = columns.map((column, index) => ({
			title: column,
			field: `c${index}`,
			headerSort: false,
			...(readOnly ? {} : { editor: 'input' as const }),
			// Default text formatter (textContent — no HTML path); the wrapper
			// only adds validation/edited classes and a tooltip to the cell DOM.
			formatter: (cell: CellComponent) => {
				const rowIndex = (cell.getRow().getData() as { __row: number }).__row;
				const issue = issueByCell.get(`${rowIndex}:${column}`);
				const element = cell.getElement();
				if (issue !== undefined) {
					element.classList.add(issue.level === 'error' ? 'migration-cell-error' : 'migration-cell-warning');
					element.setAttribute('title', issue.message);
				}
				const value = cell.getValue();
				return value === null || value === undefined ? '' : String(value);
			},
			cellEdited: (cell: CellComponent) => {
				const rowIndex = (cell.getRow().getData() as { __row: number }).__row;
				// A corrected cell sheds its issue mark — the user just overrode it.
				const element = cell.getElement();
				element.classList.remove('migration-cell-error', 'migration-cell-warning');
				element.removeAttribute('title');
				element.classList.add('migration-cell-edited');
				onCellEditedRef.current({
					row: rowIndex,
					column,
					before: (sampleRows[rowIndex]?.[index] ?? null) as MigrationCell,
					after: String(cell.getValue() ?? ''),
				});
			},
		}));

		const table = new TabulatorFull(host, {
			data,
			columns: definitions,
			layout: 'fitDataFill',
			maxHeight: 320,
		});
		return () => table.destroy();
	}, [columns, sampleRows, validations, readOnly]);

	return <div className="migration-grid" ref={hostRef} />;
}
