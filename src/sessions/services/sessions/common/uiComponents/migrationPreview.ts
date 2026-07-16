/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The `migration_preview` card: a data-migration proposal the user reviews
 * before execution — source→target field mappings plus a TRANSFORMED SAMPLE
 * of the data (never the full set: caps below are enforced main-side in the
 * tool's validateInput, so an oversized call is refused with a corrective
 * error before it ever reaches the transcript). The user can correct sample
 * cells in the grid; corrections travel back to the model as example-based
 * rules ("generalize these to the full dataset"), not as row patches.
 *
 * Grid-free on purpose — this module is imported by main-process tool
 * validation and bare-node unit tests alike.
 */

export const MIGRATION_CAPS = {
	mappings: 100,
	columns: 40,
	sampleRows: 50,
	validations: 200,
	cellChars: 500,
} as const;

export interface IMigrationFieldMapping {
	/** Source column, e.g. "orders.cust_name". */
	readonly source: string;
	/** Target column, e.g. "customers.name". */
	readonly target: string;
	/** Human-readable transform, e.g. "trim + title-case". */
	readonly transform?: string;
	readonly note?: string;
}

export interface IMigrationValidation {
	/** Index into sampleRows. */
	readonly row: number;
	/** TARGET column name — must be one of `columns`. */
	readonly column: string;
	readonly level: 'error' | 'warning';
	readonly message: string;
}

export type MigrationCell = string | number | boolean | null;

export interface IMigrationPreviewProps {
	/** e.g. "mysql:legacy_orders". */
	readonly sourceLabel: string;
	/** e.g. "pg:orders_v2". */
	readonly targetLabel: string;
	readonly mappings: readonly IMigrationFieldMapping[];
	/** Target-column order for the sample grid. */
	readonly columns: readonly string[];
	/** Transformed SAMPLE, row-major, each row matching `columns`. */
	readonly sampleRows: readonly (readonly MigrationCell[])[];
	readonly validations?: readonly IMigrationValidation[];
	/** Full dataset size, display-only ("50 / 12,340 行"). */
	readonly totalRowCount?: number;
	/** Markdown rendered under the grid. */
	readonly note?: string;
}

function isCell(value: unknown): value is MigrationCell {
	return value === null || typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= MIGRATION_CAPS.cellChars);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

/** Validate raw props; returns undefined (never throws) on any shape or cap violation. */
export function parseMigrationPreviewProps(props: unknown): IMigrationPreviewProps | undefined {
	if (typeof props !== 'object' || props === null) {
		return undefined;
	}
	const record = props as Record<string, unknown>;
	if (!isNonEmptyString(record.sourceLabel) || !isNonEmptyString(record.targetLabel)) {
		return undefined;
	}

	const { mappings, columns, sampleRows, validations, totalRowCount, note } = record;
	if (!Array.isArray(mappings) || mappings.length === 0 || mappings.length > MIGRATION_CAPS.mappings) {
		return undefined;
	}
	const parsedMappings: IMigrationFieldMapping[] = [];
	for (const raw of mappings) {
		if (typeof raw !== 'object' || raw === null) {
			return undefined;
		}
		const mapping = raw as Record<string, unknown>;
		if (!isNonEmptyString(mapping.source) || !isNonEmptyString(mapping.target)) {
			return undefined;
		}
		if ((mapping.transform !== undefined && typeof mapping.transform !== 'string') || (mapping.note !== undefined && typeof mapping.note !== 'string')) {
			return undefined;
		}
		parsedMappings.push({
			source: mapping.source,
			target: mapping.target,
			...(mapping.transform !== undefined ? { transform: mapping.transform } : {}),
			...(mapping.note !== undefined ? { note: mapping.note } : {}),
		});
	}

	if (!Array.isArray(columns) || columns.length === 0 || columns.length > MIGRATION_CAPS.columns || !columns.every(isNonEmptyString)) {
		return undefined;
	}
	if (!Array.isArray(sampleRows) || sampleRows.length > MIGRATION_CAPS.sampleRows) {
		return undefined;
	}
	for (const row of sampleRows) {
		if (!Array.isArray(row) || row.length !== columns.length || !row.every(isCell)) {
			return undefined;
		}
	}

	let parsedValidations: IMigrationValidation[] | undefined;
	if (validations !== undefined) {
		if (!Array.isArray(validations) || validations.length > MIGRATION_CAPS.validations) {
			return undefined;
		}
		parsedValidations = [];
		for (const raw of validations) {
			if (typeof raw !== 'object' || raw === null) {
				return undefined;
			}
			const validation = raw as Record<string, unknown>;
			if (
				typeof validation.row !== 'number' ||
				!Number.isInteger(validation.row) ||
				validation.row < 0 ||
				validation.row >= sampleRows.length ||
				!isNonEmptyString(validation.column) ||
				!columns.includes(validation.column) ||
				(validation.level !== 'error' && validation.level !== 'warning') ||
				!isNonEmptyString(validation.message)
			) {
				return undefined;
			}
			parsedValidations.push({ row: validation.row, column: validation.column, level: validation.level, message: validation.message });
		}
	}

	if (totalRowCount !== undefined && (typeof totalRowCount !== 'number' || !Number.isInteger(totalRowCount) || totalRowCount < 0)) {
		return undefined;
	}
	if (note !== undefined && typeof note !== 'string') {
		return undefined;
	}

	return {
		sourceLabel: record.sourceLabel,
		targetLabel: record.targetLabel,
		mappings: parsedMappings,
		columns: columns as string[],
		sampleRows: sampleRows as MigrationCell[][],
		...(parsedValidations !== undefined ? { validations: parsedValidations } : {}),
		...(totalRowCount !== undefined ? { totalRowCount } : {}),
		...(note !== undefined ? { note } : {}),
	};
}

/** One user-corrected sample cell, keyed by target column. */
export interface IMigrationCellEdit {
	readonly row: number;
	readonly column: string;
	readonly before: MigrationCell;
	readonly after: string;
}

function mappingLine(mapping: IMigrationFieldMapping): string {
	const transform = mapping.transform !== undefined && mapping.transform.trim() !== '' ? `（transform: ${mapping.transform}）` : '';
	return `- ${mapping.source} → ${mapping.target}${transform}`;
}

function editLine(edit: IMigrationCellEdit): string {
	return `- 第 ${edit.row + 1} 行 [${edit.column}]: "${edit.before ?? ''}" → "${edit.after}"`;
}

/** The confirm turn: what the model reads when the user clicks 按此执行. */
export function buildMigrationConfirmTurn(props: IMigrationPreviewProps, edits: readonly IMigrationCellEdit[]): string {
	const lines = [`我确认了迁移映射预览（${props.sourceLabel} → ${props.targetLabel}），按以下配置执行：`, '字段映射：', ...props.mappings.map(mappingLine)];
	if (edits.length > 0) {
		lines.push(`样例单元格人工修正（共 ${edits.length} 处 — 这些是修正规则的示例，执行时请把对应规则推广到全量数据）：`, ...edits.map(editLine));
	}
	lines.push('请先展示将要执行的迁移 SQL，再用 execute_data_source 分批执行——每条写语句都会经过我的审批。');
	return lines.join('\n');
}

/**
 * The revise turn: cell corrections become example-based instructions. Returns
 * undefined when there are no edits and no note — the caller falls back to
 * focusing the composer (the user says what to change in their own words).
 */
export function buildMigrationReviseTurn(props: IMigrationPreviewProps, edits: readonly IMigrationCellEdit[], userNote?: string): string | undefined {
	const note = userNote?.trim() ?? '';
	if (edits.length === 0 && note === '') {
		return undefined;
	}
	const lines = [`我审阅了迁移映射预览（${props.sourceLabel} → ${props.targetLabel}），需要调整：`];
	if (edits.length > 0) {
		lines.push('以下样例单元格的转换结果不对（我给出了期望值 — 请据此修正对应字段的转换规则）：', ...edits.map(editLine));
	}
	if (note !== '') {
		lines.push(note);
	}
	lines.push('请修订后重新调用 render_ui（component=migration_preview）给出新预览。');
	return lines.join('\n');
}
