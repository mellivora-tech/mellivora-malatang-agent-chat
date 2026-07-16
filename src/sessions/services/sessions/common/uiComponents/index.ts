/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The component vocabulary for `render_ui` cards, shared between the main
 * process (tool schema enum + validateInput) and the renderer (the visual
 * registry in agentUi/registry.ts keys off the same names). Adding a component
 * type means: a props parser listed here, a React component registered in the
 * renderer — and nothing else (no new role, no storage or agent-loop changes).
 *
 * MUST stay grid-free: unit tests import this under bare `node --test`, so
 * nothing here may (transitively) import React, Tabulator, or CSS.
 */

import { parseMigrationPreviewProps } from './migrationPreview.js';

/**
 * A props validator: returns the parsed, trusted props on success, undefined
 * on any shape/cap violation. Never throws — the caller turns undefined into
 * a corrective tool error for the model.
 */
export type UiPropsValidator = (props: unknown) => unknown | undefined;

export const UI_COMPONENT_VALIDATORS: Readonly<Record<string, UiPropsValidator>> = {
	migration_preview: parseMigrationPreviewProps,
};

export const UI_COMPONENT_NAMES: readonly string[] = Object.keys(UI_COMPONENT_VALIDATORS);

/**
 * Model-facing usage guidance per component, folded into the render_ui tool
 * description — teaching a new card's calling convention lives HERE, next to
 * its validator, never in the tool itself.
 */
export const UI_COMPONENT_GUIDANCE: Readonly<Record<string, string>> = {
	migration_preview:
		'migration_preview — use when proposing a data migration / field mapping. First read BOTH schemas (list_data_sources + query_data_source), then present the source→target mappings and a TRANSFORMED sample (max 50 rows, 500 chars/cell — a sample, never the full set) for the user to review and correct. ' +
		'props: { sourceLabel, targetLabel, sourceTable, targetTable, dialect (mysql|postgres), mappings: [{ source, target, transform? (prose for the reviewer), transformSql? (executable SQL expression producing the target value, e.g. "TRIM(cust_name)" — omit when the column carries over as-is), note? }], columns: [target column order], sampleRows: [[cells matching columns]], validations?: [{ row (0-BASED index into sampleRows: first row = 0), column, level: error|warning, message }], totalRowCount?, filterSql? (WHERE-clause body, no keyword), note? }. ' +
		'ALWAYS supply sourceTable/targetTable/dialect and a transformSql for every non-trivial mapping — they let the card compile and export the migration script locally; without them the card is review-only. ' +
		'Put suspicious conversions in validations. The user can edit sample cells; their confirmation or corrections come back as a message.',
};
