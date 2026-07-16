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
	/** Ceiling for a transformSql expression and for table identifiers. */
	sqlChars: 500,
} as const;

export interface IMigrationFieldMapping {
	/** Source column, e.g. "orders.cust_name". */
	readonly source: string;
	/** Target column, e.g. "customers.name". */
	readonly target: string;
	/** Human-readable transform, e.g. "trim + title-case". */
	readonly transform?: string;
	/**
	 * Machine-executable SQL expression producing the target value, e.g.
	 * "TRIM(cust_name)" or "amount_cents / 100". Absent means the source column
	 * carries over as-is. This is what buildMigrationSql compiles — `transform`
	 * is only ever prose for the reviewer.
	 */
	readonly transformSql?: string;
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
	/** Display label, e.g. "mysql:legacy_orders" — NOT necessarily a valid table identifier. */
	readonly sourceLabel: string;
	/** Display label, e.g. "pg:orders_v2". */
	readonly targetLabel: string;
	/**
	 * SQL-quotable source table identifier ("user_bak" or "test.user_bak").
	 * Together with targetTable + dialect this is what makes the card able to
	 * COMPILE the migration locally (buildMigrationSql / export) — without
	 * them the card is review-only.
	 */
	readonly sourceTable?: string;
	readonly targetTable?: string;
	/** Identifier-quoting dialect for the generated SQL. */
	readonly dialect?: 'mysql' | 'postgres';
	readonly mappings: readonly IMigrationFieldMapping[];
	/** Target-column order for the sample grid. */
	readonly columns: readonly string[];
	/** Transformed SAMPLE, row-major, each row matching `columns`. */
	readonly sampleRows: readonly (readonly MigrationCell[])[];
	readonly validations?: readonly IMigrationValidation[];
	/** Full dataset size, display-only ("50 / 12,340 行"). */
	readonly totalRowCount?: number;
	/** Optional WHERE-clause body (no "WHERE" keyword) filtering the source rows. */
	readonly filterSql?: string;
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

	const { mappings, columns, sampleRows, validations, totalRowCount, note, sourceTable, targetTable, dialect, filterSql } = record;
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
		if (mapping.transformSql !== undefined && (typeof mapping.transformSql !== 'string' || mapping.transformSql.length > MIGRATION_CAPS.sqlChars)) {
			return undefined;
		}
		parsedMappings.push({
			source: mapping.source,
			target: mapping.target,
			...(mapping.transform !== undefined ? { transform: mapping.transform } : {}),
			...(mapping.transformSql !== undefined && mapping.transformSql.trim() !== '' ? { transformSql: mapping.transformSql } : {}),
			...(mapping.note !== undefined ? { note: mapping.note } : {}),
		});
	}

	// The compile-enabling trio: each optional, each capped; a wrong dialect
	// value degrades to "review-only card", never a refusal.
	if (sourceTable !== undefined && (!isNonEmptyString(sourceTable) || sourceTable.length > MIGRATION_CAPS.sqlChars)) {
		return undefined;
	}
	if (targetTable !== undefined && (!isNonEmptyString(targetTable) || targetTable.length > MIGRATION_CAPS.sqlChars)) {
		return undefined;
	}
	const parsedDialect = dialect === 'mysql' || dialect === 'postgres' ? dialect : undefined;
	if (filterSql !== undefined && (typeof filterSql !== 'string' || filterSql.length > MIGRATION_CAPS.sqlChars)) {
		return undefined;
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

	// Validations are ADVISORY highlights — a malformed entry is dropped, never
	// allowed to kill the whole card (first real-Kimi smoke test lost both cards
	// to exactly this: 1-based row numbers). Two-pass: collect the well-shaped
	// entries, detect the unambiguous 1-based fingerprint (some row === N while
	// none === 0 — impossible as 0-based), shift if so, then drop any survivor
	// still out of range.
	let parsedValidations: IMigrationValidation[] | undefined;
	if (validations !== undefined) {
		if (!Array.isArray(validations) || validations.length > MIGRATION_CAPS.validations) {
			return undefined;
		}
		const wellShaped: IMigrationValidation[] = [];
		for (const raw of validations) {
			if (typeof raw !== 'object' || raw === null) {
				continue;
			}
			const validation = raw as Record<string, unknown>;
			if (
				typeof validation.row !== 'number' ||
				!Number.isInteger(validation.row) ||
				!isNonEmptyString(validation.column) ||
				!columns.includes(validation.column) ||
				(validation.level !== 'error' && validation.level !== 'warning') ||
				!isNonEmptyString(validation.message)
			) {
				continue;
			}
			wellShaped.push({ row: validation.row, column: validation.column, level: validation.level, message: validation.message });
		}
		const oneBased = wellShaped.some(validation => validation.row === sampleRows.length) && !wellShaped.some(validation => validation.row === 0);
		parsedValidations = wellShaped
			.map(validation => (oneBased ? { ...validation, row: validation.row - 1 } : validation))
			.filter(validation => validation.row >= 0 && validation.row < sampleRows.length);
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
		...(sourceTable !== undefined ? { sourceTable: sourceTable as string } : {}),
		...(targetTable !== undefined ? { targetTable: targetTable as string } : {}),
		...(parsedDialect !== undefined ? { dialect: parsedDialect } : {}),
		mappings: parsedMappings,
		columns: columns as string[],
		sampleRows: sampleRows as MigrationCell[][],
		...(parsedValidations !== undefined ? { validations: parsedValidations } : {}),
		...(totalRowCount !== undefined ? { totalRowCount } : {}),
		...(filterSql !== undefined && (filterSql as string).trim() !== '' ? { filterSql: filterSql as string } : {}),
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

/**
 * One in-card mapping override, keyed by the mapping's index in props.mappings.
 * Absent fields = unchanged; `dropped` excludes the field from the migration
 * (and from the compiled SQL) without forgetting it — restore = delete the edit.
 */
export interface IMigrationMappingEdit {
	readonly index: number;
	readonly target?: string;
	readonly transformSql?: string;
	readonly dropped?: boolean;
}

/**
 * The mappings as the user has edited them: overrides applied, dropped fields
 * excluded. This is the single source both the compiled SQL and the confirm
 * turn derive from — the model executes exactly what the card showed.
 */
export function applyMappingEdits(mappings: readonly IMigrationFieldMapping[], edits: readonly IMigrationMappingEdit[]): IMigrationFieldMapping[] {
	const byIndex = new Map(edits.map(edit => [edit.index, edit]));
	const effective: IMigrationFieldMapping[] = [];
	for (const [index, mapping] of mappings.entries()) {
		const edit = byIndex.get(index);
		if (edit?.dropped) {
			continue;
		}
		// An edited transformSql REPLACES the original; clearing it to blank
		// removes the expression entirely (back to carry-over semantics).
		const transformSql = edit?.transformSql !== undefined ? (edit.transformSql.trim() !== '' ? edit.transformSql : undefined) : mapping.transformSql;
		effective.push({
			source: mapping.source,
			target: edit?.target !== undefined && edit.target.trim() !== '' ? edit.target : mapping.target,
			...(mapping.transform !== undefined ? { transform: mapping.transform } : {}),
			...(transformSql !== undefined ? { transformSql } : {}),
			...(mapping.note !== undefined ? { note: mapping.note } : {}),
		});
	}
	return effective;
}

function mappingLine(mapping: IMigrationFieldMapping): string {
	const transform = mapping.transform !== undefined && mapping.transform.trim() !== '' ? `（transform: ${mapping.transform}）` : '';
	return `- ${mapping.source} → ${mapping.target}${transform}`;
}

function editLine(edit: IMigrationCellEdit): string {
	return `- 第 ${edit.row + 1} 行 [${edit.column}]: "${edit.before ?? ''}" → "${edit.after}"`;
}

/**
 * The confirm turn: what the model reads when the user clicks 按此执行. The
 * mappings listed are the EFFECTIVE (user-edited) ones; dropped fields are
 * named so the model knows they were deliberate. When the card compiled the
 * SQL locally, the exact statement rides the turn and the model is told to
 * execute it verbatim — regeneration drift is the failure mode this kills.
 */
export function buildMigrationConfirmTurn(
	props: IMigrationPreviewProps,
	edits: readonly IMigrationCellEdit[],
	options?: { readonly mappingEdits?: readonly IMigrationMappingEdit[]; readonly compiledSql?: string },
): string {
	const mappingEdits = options?.mappingEdits ?? [];
	const effective = mappingEdits.length > 0 ? applyMappingEdits(props.mappings, mappingEdits) : props.mappings;
	const dropped = mappingEdits.filter(edit => edit.dropped).map(edit => props.mappings[edit.index]?.source ?? `#${edit.index}`);

	const lines = [
		`我确认了迁移映射预览（${props.sourceLabel} → ${props.targetLabel}），按以下配置执行${mappingEdits.length > 0 ? '（我在卡片中做过调整，以下为调整后的最终配置）' : ''}：`,
		'字段映射：',
		...effective.map(mappingLine),
	];
	if (dropped.length > 0) {
		lines.push(`我丢弃了这些源字段（不迁移）：${dropped.join('、')}`);
	}
	if (edits.length > 0) {
		lines.push(`样例单元格人工修正（共 ${edits.length} 处 — 这些是修正规则的示例，执行时请把对应规则推广到全量数据）：`, ...edits.map(editLine));
	}
	if (options?.compiledSql !== undefined && options.compiledSql.trim() !== '') {
		lines.push('以下是卡片按上述配置编译出的迁移 SQL——请用 execute_data_source 原样执行这一条语句，不要重新生成：', '```sql', options.compiledSql, '```');
	} else {
		lines.push('请先展示将要执行的迁移 SQL，再用 execute_data_source 分批执行——每条写语句都会经过我的审批。');
	}
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

// --- local SQL compilation (the card as a computer, not just a dialog) ------

/**
 * Quote one identifier segment per dialect; a dotted name ("test.user_bak")
 * quotes each segment. Embedded quote characters are escaped by doubling —
 * identifiers are model-authored, and while the generated script is always
 * user-reviewed (and approval-gated at execution), a broken identifier must
 * not be able to terminate the quoting context.
 */
export function quoteIdentifier(name: string, dialect: 'mysql' | 'postgres'): string {
	const quote = dialect === 'mysql' ? '`' : '"';
	return name
		.split('.')
		.map(segment => `${quote}${segment.replaceAll(quote, quote + quote)}${quote}`)
		.join('.');
}

/**
 * Compile the mapping into a single set-based migration statement:
 *
 *   INSERT INTO target (t1, t2, …)
 *   SELECT expr1, expr2, … FROM source [WHERE filter];
 *
 * Pure and deterministic — the export button and (later) the in-card SQL
 * preview both call this, so an edited mapping always compiles to the same
 * script everywhere. Returns undefined when the card lacks the compile trio
 * (sourceTable/targetTable/dialect): such a card is review-only and callers
 * disable export. The result is ONE statement by construction, matching
 * execute_data_source's one-statement-per-approval contract (locked by test
 * against isSingleStatement).
 */
export function buildMigrationSql(props: IMigrationPreviewProps): string | undefined {
	const { sourceTable, targetTable, dialect } = props;
	if (sourceTable === undefined || targetTable === undefined || dialect === undefined) {
		return undefined;
	}
	const targetColumns = props.mappings.map(mapping => quoteIdentifier(mapping.target, dialect));
	const selectExpressions = props.mappings.map(mapping => {
		const expression = mapping.transformSql?.trim();
		return expression !== undefined && expression !== '' ? expression : quoteIdentifier(mapping.source, dialect);
	});
	const filter = props.filterSql?.trim();
	return [
		`INSERT INTO ${quoteIdentifier(targetTable, dialect)} (${targetColumns.join(', ')})`,
		`SELECT ${selectExpressions.join(', ')}`,
		`FROM ${quoteIdentifier(sourceTable, dialect)}${filter !== undefined && filter !== '' ? `\nWHERE ${filter}` : ''};`,
	].join('\n');
}
