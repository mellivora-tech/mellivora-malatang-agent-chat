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
	| { readonly kind: 'cells' } // array of rows; each row an array of string|number|boolean|null
	| { readonly kind: 'capabilities'; readonly allow: readonly CapName[] }; // [@Cap(...), ...] enriching this primitive in place

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

/**
 * Capability declarations (#12 M5, design §8): mini-constructors that ENRICH an
 * existing primitive's existing shape in place — never a new structure (that is
 * a mechanism component; §8.1). They ride the Action `@Step` surface syntax
 * (`@Cap(...)`), reusing that parse kernel, and carry the SAME positional-ABI +
 * same-source doc as components — so the parser validator and the prompt can't
 * drift (Q-F承重墙 extended). Opener set (D4): Editable / Validate only.
 */
export const CAP_NAMES = ['Editable', 'Validate'] as const;
export type CapName = (typeof CAP_NAMES)[number];

export interface ICapSpec {
	readonly name: CapName;
	readonly doc: string;
	readonly args: readonly IArgSpec[];
}

export const CAP_SPECS: readonly ICapSpec[] = [
	{
		name: 'Editable',
		doc: "Make a table column's cells editable in place. Edits stay local (Tier 0) and enter the form snapshot; they never reach you until an @ToAssistant.",
		args: [
			{ name: 'target', type: { kind: 'string' }, doc: 'the column HEADER whose cells become editable (by name, not index)' },
			{ name: 'placeholder', type: { kind: 'string' }, optional: true },
		],
	},
	{
		name: 'Validate',
		doc: 'Highlight a table column\'s cells that fail a regex. Non-blocking: invalid cells show the hint but never stop @ToAssistant; invalid targets ride the form snapshot so you can see them. required = pattern ".+"; enum = "a|b|c".',
		args: [
			{ name: 'target', type: { kind: 'string' }, doc: 'the column HEADER to validate (by name)' },
			{ name: 'pattern', type: { kind: 'string' }, doc: 'a JS regex source, e.g. "^\\\\d+$"; a cell whose text matches is valid' },
			{ name: 'hint', type: { kind: 'string' }, doc: 'shown on invalid cells' },
		],
	},
];

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
		doc: 'Data table. Optional caps make columns editable / validated in place (no separate component).',
		args: [
			{ name: 'columns', type: { kind: 'strings' }, doc: 'column headers' },
			{ name: 'rows', type: { kind: 'cells' }, doc: 'row-major cells; cell = string | number | boolean | null' },
			{
				name: 'caps',
				type: { kind: 'capabilities', allow: ['Editable', 'Validate'] },
				optional: true,
				doc: 'e.g. [@Editable("目标字段"), @Validate("金额", "^\\\\d+$", "金额需为数字")]',
			},
		],
	},
	{
		name: 'Code',
		doc: 'A monospace code / snippet block for exportable artifacts (SQL, scripts). Read-only display; export/run go through a Button Action.',
		args: [
			{ name: 'content', type: { kind: 'string' }, doc: 'the code text (use \\n for line breaks)' },
			{ name: 'language', type: { kind: 'string' }, optional: true, doc: 'a language tag shown as a label, e.g. "sql" / "python"' },
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
	{
		name: 'field_mapping',
		doc: 'Drag-line canvas pairing a source field set to a target field set — the ONE mechanism component (direct manipulation atoms cannot compose). Same canvas serves table→table / file→table / table→file via the endpoint labels. Drag edits stay local (Tier 0); the pairing rides the @ToAssistant snapshot.',
		args: [
			{ name: 'source', type: { kind: 'string' }, doc: 'source endpoint label, e.g. "staging.orders (file)"' },
			{ name: 'sourceFields', type: { kind: 'strings' }, doc: 'source field names (left column)' },
			{ name: 'target', type: { kind: 'string' }, doc: 'target endpoint label' },
			{ name: 'targetFields', type: { kind: 'strings' }, doc: 'target field names (right column)' },
			{ name: 'mappings', type: { kind: 'cells' }, optional: true, doc: 'initial pairings [[sourceField, targetField], ...]; drag edits them (1:1)' },
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
		case 'capabilities':
			return `[${type.allow.map(cap => `@${cap}(...)`).join(' | ')}, ...]`;
	}
}

/** One capability's positional signature line — same shape as a component signature, same source. */
function describeCap(cap: ICapSpec): string {
	const args = cap.args.map(arg => `${arg.name}${arg.optional ? '?' : ''}: ${describeType(arg.type)}${arg.doc ? ` — ${arg.doc}` : ''}`);
	return `@${cap.name}(${cap.args.map(arg => arg.name + (arg.optional ? '?' : '')).join(', ')})\n  ${cap.doc}\n  ${args.join('\n  ')}`;
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
	// Only document capabilities some registered primitive actually accepts — the
	// token diet (§7.3) extends to the cap vocabulary too.
	const allowed = new Set<CapName>();
	for (const component of catalog) {
		for (const arg of component.args) {
			if (arg.type.kind === 'capabilities') {
				for (const cap of arg.type.allow) {
					allowed.add(cap);
				}
			}
		}
	}
	const capSection = CAP_SPECS.filter(cap => allowed.has(cap.name));
	const capBlock =
		capSection.length === 0
			? []
			: [
					'',
					'CAPABILITIES (an argument typed [@Cap(...), ...] accepts these; same @Name(args) form as action steps)',
					capSection.map(describeCap).join('\n'),
					'',
					'EXAMPLE 3 — editable + validated table (no separate component):',
					'root = Stack([tbl])',
					'tbl = Table(["源字段", "目标字段", "金额"], [["order_no", "order_id", "128"], ["amt", "amount", "x"]], [@Editable("目标字段"), @Validate("金额", "^\\\\d+$", "金额需为数字")])',
				];
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
		...capBlock,
	].join('\n');
}
