/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo, useState } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import { SMOKE_CATALOG } from '../../../../common/uiDsl/catalog.js';
import { foldSurface, type ISurfaceNode, type SurfaceValue } from '../../../../common/uiDsl/fold.js';
import { parseFieldLinks, serializeFieldLinks, type IFieldMappingLink } from '../../../../common/uiDsl/fieldMapping.js';
import { FieldMappingView } from './FieldMappingView.js';

/**
 * The workbench surface renderer (#12 M4): folds the session's statement
 * batches and renders the tree with the smoke vocabulary. Editing state stays
 * HERE (the three-spec consensus): the model sees it only inside the
 * @ToAssistant snapshot. `formState` holds USER EDITS only — reading falls
 * back to the fold's declared defaults, so @Reset is just "delete the edit".
 */

export interface ISurfacePanelProps {
	readonly batches: readonly string[];
	/** @ToAssistant: the confirm turn (message text + form snapshot) heads back to the model. */
	readonly onToAssistant: (text: string) => void;
}

type FormValue = string | number | boolean | null;

interface IColValidator {
	readonly pattern: string;
	readonly hint: string;
}

interface ITableCaps {
	readonly colNames: readonly string[];
	/** column header → placeholder (present ⇒ editable). */
	readonly editable: ReadonlyMap<string, string>;
	readonly validators: ReadonlyMap<string, IColValidator>;
}

const cellText = (value: SurfaceValue | undefined): string => (value?.kind === 'literal' && value.value !== null ? String(value.value) : '');

/** A regex that fails to compile must never mark data invalid — degrade to "valid". */
const regexOk = (pattern: string, text: string): boolean => {
	try {
		return new RegExp(pattern).test(text);
	} catch {
		return true;
	}
};

/** Stable, model-readable key for one editable/validated cell (name-first addressing, design §8.5). */
const cellKey = (tableName: string, colName: string, rowIndex: number): string => `${tableName}.${colName}[${rowIndex}]`;

/** Read a Table node's @Editable / @Validate caps off its optional third arg. */
const readTableCaps = (node: ISurfaceNode): ITableCaps => {
	const columns = node.args[0]?.kind === 'array' ? node.args[0].items : [];
	const caps = node.args[2]?.kind === 'array' ? node.args[2].items : [];
	const editable = new Map<string, string>();
	const validators = new Map<string, IColValidator>();
	for (const cap of caps) {
		if (cap.kind !== 'cap') {
			continue;
		}
		const target = cellText(cap.args[0]);
		if (cap.name === 'Editable') {
			editable.set(target, cellText(cap.args[1]));
		} else if (cap.name === 'Validate') {
			validators.set(target, { pattern: cellText(cap.args[1]), hint: cellText(cap.args[2]) });
		}
	}
	return { colNames: columns.map(cellText), editable, validators };
};

/** Visit every node of a given component type in a resolved surface tree (snapshot passes). */
const eachNode = (node: ISurfaceNode, component: string, visit: (node: ISurfaceNode) => void): void => {
	if (node.component === component) {
		visit(node);
	}
	for (const arg of node.args) {
		eachNodeInValue(arg, component, visit);
	}
};

const eachNodeInValue = (value: SurfaceValue, component: string, visit: (node: ISurfaceNode) => void): void => {
	if (value.kind === 'node') {
		eachNode(value.node, component, visit);
	} else if (value.kind === 'array') {
		for (const item of value.items) {
			eachNodeInValue(item, component, visit);
		}
	}
};

/** Row-major literal cells off an array SurfaceValue (used by Table + field_mapping mappings). */
const surfaceRows = (value: SurfaceValue | undefined): (string | number | boolean | null)[][] =>
	value?.kind === 'array' ? value.items.map(row => (row.kind === 'array' ? row.items.map(item => (item.kind === 'literal' ? item.value : null)) : [])) : [];

/** A field_mapping node's declared source-endpoint fields (arg 1) as strings. */
const surfaceStrings = (value: SurfaceValue | undefined): string[] => (value?.kind === 'array' ? value.items.map(cellText) : []);

const literal = (value: SurfaceValue | undefined): FormValue => (value?.kind === 'literal' ? value.value : null);
const asText = (value: FormValue): string => (value === null ? '' : String(value));

interface ISurfaceRenderContext {
	readonly edits: Readonly<Record<string, FormValue>>;
	readonly setEdits: React.Dispatch<React.SetStateAction<Record<string, FormValue>>>;
	readonly mappingEdits: Readonly<Record<string, readonly IFieldMappingLink[]>>;
	readonly setMappingEdits: React.Dispatch<React.SetStateAction<Record<string, readonly IFieldMappingLink[]>>>;
	readonly read: (key: string) => FormValue;
	readonly runAction: (steps: readonly { readonly step: string; readonly args: readonly SurfaceValue[] }[]) => void;
}

interface ISurfaceNodeViewProps extends ISurfaceRenderContext {
	readonly node: ISurfaceNode;
}

const renderSurfaceValue = (value: SurfaceValue, key: React.Key, context: ISurfaceRenderContext): React.ReactNode => {
	if (value.kind === 'node') {
		return <SurfaceNodeView key={key} node={value.node} {...context} />;
	}
	if (value.kind === 'dangling') {
		return (
			<span key={key} className="surface-hole">
				{localize('surface.hole', value.name)}
			</span>
		);
	}
	if (value.kind === 'literal') {
		return <span key={key}>{asText(value.value)}</span>;
	}
	return null;
};

function SurfaceNodeView({ node, edits, setEdits, mappingEdits, setMappingEdits, read, runAction }: ISurfaceNodeViewProps): React.ReactElement {
	const context: ISurfaceRenderContext = { edits, setEdits, mappingEdits, setMappingEdits, read, runAction };

	switch (node.component) {
		case 'Stack': {
			const children = node.args[0];
			return <div className="surface-stack">{children?.kind === 'array' ? children.items.map((item, index) => renderSurfaceValue(item, index, context)) : null}</div>;
		}
		case 'Text': {
			const variant = literal(node.args[1]);
			const className = variant === 'title' ? 'surface-text-title' : variant === 'caption' ? 'surface-text-caption' : 'surface-text-body';
			return <div className={className}>{asText(literal(node.args[0]))}</div>;
		}
		case 'Code': {
			const language = asText(literal(node.args[1]));
			return (
				<div className="surface-code">
					{language !== '' ? <div className="surface-code-lang">{language}</div> : null}
					<pre className="surface-code-body">
						<code>{asText(literal(node.args[0]))}</code>
					</pre>
				</div>
			);
		}
		case 'Table': {
			const columns = node.args[0]?.kind === 'array' ? node.args[0].items : [];
			const rows = node.args[1]?.kind === 'array' ? node.args[1].items : [];
			const { colNames, editable, validators } = readTableCaps(node);
			return (
				<table className="surface-table">
					<thead>
						<tr>
							{columns.map((column, index) => (
								<th key={index}>{column.kind === 'literal' ? asText(column.value) : null}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.kind === 'array'
									? row.items.map((cell, cellIndex) => {
											const colName = colNames[cellIndex] ?? '';
											const key = cellKey(node.name, colName, rowIndex);
											const current: FormValue = key in edits ? (edits[key] ?? null) : cell.kind === 'literal' ? cell.value : null;
											const validator = validators.get(colName);
											const invalid = validator !== undefined && !regexOk(validator.pattern, asText(current));
											return (
												<td key={cellIndex} className={invalid ? 'surface-cell-invalid' : undefined} title={invalid ? validator.hint : undefined}>
													{editable.has(colName) ? (
														<input
															type="text"
															className="surface-cell-input"
															value={asText(current)}
															placeholder={editable.get(colName) || undefined}
															aria-invalid={invalid || undefined}
															onChange={event => setEdits(previous => ({ ...previous, [key]: event.target.value }))}
														/>
													) : (
														asText(current)
													)}
												</td>
											);
										})
									: null}
							</tr>
						))}
					</tbody>
				</table>
			);
		}
		case 'TextField': {
			const binding = node.args[1]?.kind === 'state' ? node.args[1].name : `#${node.name}`;
			return (
				<label className="surface-field">
					<span>{asText(literal(node.args[0]))}</span>
					<input type="text" value={asText(read(binding))} onChange={event => setEdits(previous => ({ ...previous, [binding]: event.target.value }))} />
				</label>
			);
		}
		case 'Select': {
			const options = node.args[1]?.kind === 'array' ? node.args[1].items : [];
			const binding = node.args[2]?.kind === 'state' ? node.args[2].name : `#${node.name}`;
			return (
				<label className="surface-field">
					<span>{asText(literal(node.args[0]))}</span>
					<select value={asText(read(binding))} onChange={event => setEdits(previous => ({ ...previous, [binding]: event.target.value }))}>
						{options.map((option, index) => (
							<option key={index} value={option.kind === 'literal' ? asText(option.value) : ''}>
								{option.kind === 'literal' ? asText(option.value) : ''}
							</option>
						))}
					</select>
				</label>
			);
		}
		case 'Button': {
			const action = node.args[1];
			return (
				<button type="button" className="surface-button" onClick={() => action?.kind === 'action' && runAction(action.steps)}>
					{asText(literal(node.args[0]))}
				</button>
			);
		}
		case 'field_mapping': {
			const key = `${node.name}.mappings`;
			const links = mappingEdits[key] ?? parseFieldLinks(surfaceRows(node.args[4]));
			return (
				<FieldMappingView
					sourceLabel={asText(literal(node.args[0]))}
					sourceFields={surfaceStrings(node.args[1])}
					targetLabel={asText(literal(node.args[2]))}
					targetFields={surfaceStrings(node.args[3])}
					links={links}
					onChange={next => setMappingEdits(previous => ({ ...previous, [key]: next }))}
				/>
			);
		}
		default:
			return <div className="surface-hole">{localize('surface.hole', node.component)}</div>;
	}
}

export function SurfacePanel({ batches, onToAssistant }: ISurfacePanelProps): React.ReactElement {
	const folded = useMemo(() => foldSurface(batches, SMOKE_CATALOG), [batches]);
	const [edits, setEdits] = useState<Record<string, FormValue>>({});
	// field_mapping links are arrays, not scalars — a parallel edit map keyed by
	// `${node.name}.mappings`. Absent an entry, the node's declared pairings win.
	const [mappingEdits, setMappingEdits] = useState<Record<string, readonly IFieldMappingLink[]>>({});

	const read = (key: string): FormValue => edits[key] ?? folded.states.get(key) ?? '';

	const snapshot = (): string => {
		const entries: string[] = [];
		for (const [name] of folded.states) {
			entries.push(`${name} = ${JSON.stringify(read(name))}`);
		}
		for (const [key, value] of Object.entries(edits)) {
			if (!key.startsWith('$')) {
				entries.push(`${key} = ${JSON.stringify(value)}`);
			}
		}
		// Invalid targets ride the snapshot (design §8.4): non-blocking, but the
		// model must be able to SEE which cells fail — including original cells the
		// user never touched.
		if (folded.root) {
			eachNode(folded.root, 'Table', node => {
				const { colNames, validators } = readTableCaps(node);
				if (validators.size === 0) {
					return;
				}
				const rows = node.args[1]?.kind === 'array' ? node.args[1].items : [];
				rows.forEach((row, rowIndex) => {
					if (row.kind !== 'array') {
						return;
					}
					row.items.forEach((cell, colIndex) => {
						const colName = colNames[colIndex] ?? '';
						const validator = validators.get(colName);
						if (!validator) {
							return;
						}
						const key = cellKey(node.name, colName, rowIndex);
						const value = key in edits ? asText(edits[key] ?? null) : cellText(cell);
						if (!regexOk(validator.pattern, value)) {
							entries.push(`# invalid ${key} = ${JSON.stringify(value)} (${validator.hint})`);
						}
					});
				});
			});
		}
		// field_mapping pairings ride the snapshot in readable arrow form —
		// EFFECTIVE links (dragged edits, else the declared pairing), so a
		// reviewed-but-untouched mapping still reaches the model on confirm.
		if (folded.root) {
			eachNode(folded.root, 'field_mapping', node => {
				const key = `${node.name}.mappings`;
				const links = mappingEdits[key] ?? parseFieldLinks(surfaceRows(node.args[4]));
				entries.push(`${key} = ${serializeFieldLinks(links)}`);
			});
		}
		return entries.join('\n');
	};

	const runAction = (steps: readonly { readonly step: string; readonly args: readonly SurfaceValue[] }[]): void => {
		for (const { step, args } of steps) {
			if (step === 'Set' && args[0]?.kind === 'state' && args[1]?.kind === 'literal') {
				const name = args[0].name;
				const value = args[1].value;
				setEdits(previous => ({ ...previous, [name]: value }));
			} else if (step === 'Reset' && args[0]?.kind === 'state') {
				const name = args[0].name;
				setEdits(previous => {
					const next = { ...previous };
					delete next[name];
					return next;
				});
			} else if (step === 'ToAssistant' && args[0]?.kind === 'literal' && typeof args[0].value === 'string') {
				const state = snapshot();
				onToAssistant(state === '' ? args[0].value : `${args[0].value}\n\n<form-state>\n${state}\n</form-state>`);
			}
			// @Run: no local tools are registered in M4 — parsed, ignored.
		}
	};

	const nodeViewContext: ISurfaceRenderContext = {
		edits,
		setEdits,
		mappingEdits,
		setMappingEdits,
		read,
		runAction,
	};

	if (!folded.root) {
		return <div className="surface-empty">{localize('surface.empty')}</div>;
	}
	return (
		<div className="surface-panel-body">
			<SurfaceNodeView node={folded.root} {...nodeViewContext} />
			{folded.errors.length > 0 ? <div className="surface-text-caption">{localize('surface.errorNote', folded.errors.length)}</div> : null}
		</div>
	);
}
