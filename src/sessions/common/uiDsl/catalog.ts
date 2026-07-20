/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The same-source component catalog (#12 M2, design §3): ONE argument-spec
 * table per primitive drives BOTH the parser's positional-argument validation
 * AND the generated system-prompt documentation. Schema/guidance drift is
 * structurally impossible — the 1-based incident's lesson, institutionalized.
 *
 * M2 scope: five smoke primitives. The real workbench vocabulary (field
 * mapping canvas etc.) lands in M5 through the same table.
 */

export type ArgType =
	| { readonly kind: 'string' }
	| { readonly kind: 'number' }
	| { readonly kind: 'enum'; readonly values: readonly string[] }
	| { readonly kind: 'binding' } // $variable reference (two-way)
	| { readonly kind: 'action' }
	| { readonly kind: 'components' } // array of component references
	| { readonly kind: 'strings' } // array of string literals
	| { readonly kind: 'cells' }; // array of rows; each row an array of string|number|boolean|null

export interface IArgSpec {
	readonly name: string;
	readonly type: ArgType;
	readonly optional?: boolean;
	/** Rendered into the generated doc — constraints the type alone can't say. */
	readonly doc?: string;
}

export interface IComponentSpec {
	readonly name: string;
	readonly doc: string;
	/** POSITIONAL ABI: argument order here IS the call syntax. */
	readonly args: readonly IArgSpec[];
}

export const SMOKE_CATALOG: readonly IComponentSpec[] = [
	{
		name: 'Stack',
		doc: 'Vertical layout container; the usual root.',
		args: [{ name: 'children', type: { kind: 'components' }, doc: 'component references, e.g. [header, tbl]' }],
	},
	{
		name: 'Text',
		doc: 'A run of text.',
		args: [
			{ name: 'content', type: { kind: 'string' } },
			{ name: 'variant', type: { kind: 'enum', values: ['title', 'body', 'caption'] }, optional: true },
		],
	},
	{
		name: 'Table',
		doc: 'Data table.',
		args: [
			{ name: 'columns', type: { kind: 'strings' }, doc: 'column headers' },
			{ name: 'rows', type: { kind: 'cells' }, doc: 'row-major cells; cell = string | number | boolean | null' },
		],
	},
	{
		name: 'TextField',
		doc: 'Single-line input.',
		args: [
			{ name: 'label', type: { kind: 'string' } },
			{ name: 'value', type: { kind: 'binding' }, optional: true, doc: 'two-way binding, e.g. $filter' },
		],
	},
	{
		name: 'Select',
		doc: 'Dropdown choice.',
		args: [
			{ name: 'label', type: { kind: 'string' } },
			{ name: 'options', type: { kind: 'strings' } },
			{ name: 'value', type: { kind: 'binding' }, optional: true },
		],
	},
	{
		name: 'Button',
		doc: 'Action trigger.',
		args: [
			{ name: 'label', type: { kind: 'string' } },
			{ name: 'action', type: { kind: 'action' }, optional: true, doc: 'e.g. Action([@Set($days, "30")]) or Action([@ToAssistant("按当前配置执行")])' },
		],
	},
];

/** Action steps the runtime understands. @Set/@Reset stay local; @ToAssistant returns to the model with the form snapshot. */
export const ACTION_STEPS = ['Set', 'Reset', 'Run', 'ToAssistant'] as const;
export type ActionStepName = (typeof ACTION_STEPS)[number];

function describeType(type: ArgType): string {
	switch (type.kind) {
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'enum':
			return type.values.map(value => `"${value}"`).join(' | ');
		case 'binding':
			return '$variable';
		case 'action':
			return 'Action([...])';
		case 'components':
			return '[componentRef, ...]';
		case 'strings':
			return '["...", ...]';
		case 'cells':
			return '[[cell, ...], ...]';
	}
}

/**
 * The generated system-prompt documentation — grammar, catalog signatures and
 * two few-shot examples, all derived from the SAME specs the parser validates
 * against. `catalog` defaults to the smoke set; M3 injects only the session's
 * registered primitives (design §7.3, token diet).
 */
export function generateDslPrompt(catalog: readonly IComponentSpec[] = SMOKE_CATALOG): string {
	const signatures = catalog
		.map(component => {
			const args = component.args.map(arg => `${arg.name}${arg.optional ? '?' : ''}: ${describeType(arg.type)}${arg.doc ? ` — ${arg.doc}` : ''}`);
			return `${component.name}(${component.args.map(arg => arg.name + (arg.optional ? '?' : '')).join(', ')})\n  ${component.doc}\n  ${args.join('\n  ')}`;
		})
		.join('\n');
	return [
		'You compose UI with a line-based DSL. Output ONLY DSL statements — no prose, no markdown fences.',
		'',
		'GRAMMAR',
		'- One statement per line: `name = Component(arg1, arg2, ...)`. Arguments are POSITIONAL, in the exact order documented below.',
		'- Exactly one `root = ...` statement is required; it is the mount point.',
		'- Reference other components by their statement name: `root = Stack([header, tbl])`. Forward references are allowed (use a name before its line).',
		'- Reactive state: `$name = <literal>` declares state with a default value; pass `$name` where a binding is accepted.',
		'- Actions: `Action([@Step(...), ...])`. Steps: @Set($var, value) / @Reset($var) — local, never reach you; @ToAssistant("message") — returns to you WITH the current form snapshot.',
		'- Literals: "double-quoted strings", numbers, true/false/null. Arrays use [a, b, c]. Indices/row numbers are 0-BASED.',
		'- A statement may span lines only while inside unclosed brackets.',
		'',
		'CATALOG (positional signatures)',
		signatures,
		'',
		'EXAMPLE 1 — static:',
		'root = Stack([title, tbl])',
		'title = Text("订单表迁移预览", "title")',
		'tbl = Table(["源字段", "目标字段"], [["order_no", "order_id"], ["amt", "amount"]])',
		'',
		'EXAMPLE 2 — stateful:',
		'$days = "7"',
		'root = Stack([range, apply])',
		'range = Select("时间范围", ["7", "30", "90"], $days)',
		'apply = Button("应用", Action([@ToAssistant("按当前筛选重新查询")]))',
	].join('\n');
}
