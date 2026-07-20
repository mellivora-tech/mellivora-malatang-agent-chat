/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ACTION_STEPS, type ActionStepName, type ArgType, type IComponentSpec } from './catalog.js';

/**
 * The line-DSL parser (#12 M2, design §2): statements split on lines (a line
 * continues while brackets stay open), recursive-descent values, catalog-driven
 * positional-argument validation, last-assignment-wins merge. Errors are
 * STRUCTURED with hints — they feed back to the model for self-correction, so
 * their quality is part of the loop, not cosmetics. Invalid statements drop;
 * everything else renders (OpenUI's graceful-degradation posture).
 */

export type DslValue =
	| { readonly kind: 'literal'; readonly value: string | number | boolean | null }
	| { readonly kind: 'ref'; readonly name: string }
	| { readonly kind: 'state'; readonly name: string }
	| { readonly kind: 'array'; readonly items: readonly DslValue[] }
	| { readonly kind: 'component'; readonly component: string; readonly args: readonly DslValue[] }
	| { readonly kind: 'action'; readonly steps: readonly IDslActionStep[] };

export interface IDslActionStep {
	readonly step: ActionStepName;
	readonly args: readonly DslValue[];
}

export interface IDslStatement {
	/** Assignment target; '$name' for state declarations. */
	readonly name: string;
	readonly value: DslValue;
	readonly line: number;
	readonly source: string;
}

export interface IDslError {
	readonly line: number;
	readonly statement?: string;
	readonly message: string;
	readonly hint?: string;
}

export interface IDslProgram {
	/** Valid statements after last-wins merge, in first-definition order. */
	readonly statements: ReadonlyMap<string, IDslStatement>;
	readonly errors: readonly IDslError[];
	/** Statement attempts (valid + failed) — the smoke metric's denominator. */
	readonly attempts: number;
}

// --- statement splitting -------------------------------------------------------

interface IRawStatement {
	readonly text: string;
	readonly line: number;
}

/** Join physical lines into logical statements: a statement continues while ( [ are unbalanced or a string is open. */
export function splitStatements(source: string): IRawStatement[] {
	const raw: IRawStatement[] = [];
	const lines = source.split('\n');
	let buffer = '';
	let startLine = 0;
	let depth = 0;
	let inString = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (buffer === '') {
			startLine = index + 1;
		}
		buffer = buffer === '' ? line : `${buffer}\n${line}`;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]!;
			if (inString) {
				if (ch === '\\') {
					i++;
				} else if (ch === '"') {
					inString = false;
				}
			} else if (ch === '"') {
				inString = true;
			} else if (ch === '(' || ch === '[') {
				depth++;
			} else if (ch === ')' || ch === ']') {
				depth--;
			}
		}
		if (depth <= 0 && !inString) {
			const text = buffer.trim();
			if (text !== '') {
				raw.push({ text, line: startLine });
			}
			buffer = '';
			depth = 0;
		}
	}
	if (buffer.trim() !== '') {
		raw.push({ text: buffer.trim(), line: startLine });
	}
	return raw;
}

// --- tokenizer -----------------------------------------------------------------

type Token =
	| { readonly kind: 'ident'; readonly text: string }
	| { readonly kind: 'state'; readonly text: string }
	| { readonly kind: 'step'; readonly text: string }
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'number'; readonly value: number }
	| { readonly kind: 'punct'; readonly text: string };

function tokenize(text: string): Token[] | string {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (ch === '"') {
			let value = '';
			i++;
			let closed = false;
			while (i < text.length) {
				const c = text[i]!;
				if (c === '\\' && i + 1 < text.length) {
					const next = text[i + 1]!;
					value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
					i += 2;
					continue;
				}
				if (c === '"') {
					closed = true;
					i++;
					break;
				}
				value += c;
				i++;
			}
			if (!closed) {
				return 'unterminated string literal';
			}
			tokens.push({ kind: 'string', value });
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
			let end = i + 1;
			while (end < text.length && /[0-9._]/.test(text[end]!)) {
				end++;
			}
			const value = Number(text.slice(i, end));
			if (Number.isNaN(value)) {
				return `not a number: ${text.slice(i, end)}`;
			}
			tokens.push({ kind: 'number', value });
			i = end;
			continue;
		}
		if (ch === '$') {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
			if (!match) {
				return '"$" must be followed by a variable name';
			}
			tokens.push({ kind: 'state', text: match[0] });
			i += 1 + match[0].length;
			continue;
		}
		if (ch === '@') {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
			if (!match) {
				return '"@" must be followed by a step name';
			}
			tokens.push({ kind: 'step', text: match[0] });
			i += 1 + match[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))!;
			tokens.push({ kind: 'ident', text: match[0] });
			i += match[0].length;
			continue;
		}
		if ('=()[],'.includes(ch)) {
			tokens.push({ kind: 'punct', text: ch });
			i++;
			continue;
		}
		return `unexpected character "${ch}"`;
	}
	return tokens;
}

// --- value parser --------------------------------------------------------------

class TokenStream {
	private index = 0;
	constructor(private readonly tokens: Token[]) {}
	peek(): Token | undefined {
		return this.tokens[this.index];
	}
	next(): Token | undefined {
		return this.tokens[this.index++];
	}
	expectPunct(text: string): boolean {
		const token = this.peek();
		if (token?.kind === 'punct' && token.text === text) {
			this.index++;
			return true;
		}
		return false;
	}
	done(): boolean {
		return this.index >= this.tokens.length;
	}
}

function parseValue(stream: TokenStream): DslValue | string {
	const token = stream.next();
	if (!token) {
		return 'expected a value';
	}
	if (token.kind === 'string') {
		return { kind: 'literal', value: token.value };
	}
	if (token.kind === 'number') {
		return { kind: 'literal', value: token.value };
	}
	if (token.kind === 'state') {
		return { kind: 'state', name: token.text };
	}
	if (token.kind === 'punct' && token.text === '[') {
		const items: DslValue[] = [];
		if (stream.expectPunct(']')) {
			return { kind: 'array', items };
		}
		while (true) {
			const item = parseValue(stream);
			if (typeof item === 'string') {
				return item;
			}
			items.push(item);
			if (stream.expectPunct(']')) {
				return { kind: 'array', items };
			}
			if (!stream.expectPunct(',')) {
				return 'expected "," or "]" in array';
			}
		}
	}
	if (token.kind === 'ident') {
		if (token.text === 'true' || token.text === 'false') {
			return { kind: 'literal', value: token.text === 'true' };
		}
		if (token.text === 'null') {
			return { kind: 'literal', value: null };
		}
		if (token.text === 'Action') {
			return parseAction(stream);
		}
		// Component call vs plain reference.
		if (stream.expectPunct('(')) {
			const args: DslValue[] = [];
			if (!stream.expectPunct(')')) {
				while (true) {
					const arg = parseValue(stream);
					if (typeof arg === 'string') {
						return arg;
					}
					args.push(arg);
					if (stream.expectPunct(')')) {
						break;
					}
					if (!stream.expectPunct(',')) {
						return `expected "," or ")" in ${token.text}(...)`;
					}
				}
			}
			return { kind: 'component', component: token.text, args };
		}
		return { kind: 'ref', name: token.text };
	}
	return `unexpected token "${token.kind === 'punct' ? token.text : (token as { text?: string }).text ?? token.kind}"`;
}

function parseAction(stream: TokenStream): DslValue | string {
	if (!stream.expectPunct('(') || !stream.expectPunct('[')) {
		return 'Action must be written Action([@Step(...), ...])';
	}
	const steps: IDslActionStep[] = [];
	if (stream.expectPunct(']')) {
		if (!stream.expectPunct(')')) {
			return 'expected ")" after Action([...])';
		}
		return { kind: 'action', steps };
	}
	while (true) {
		const token = stream.next();
		if (!token || token.kind !== 'step') {
			return 'expected @Step inside Action([...])';
		}
		if (!(ACTION_STEPS as readonly string[]).includes(token.text)) {
			return `unknown action step "@${token.text}" — allowed: ${ACTION_STEPS.map(step => '@' + step).join(', ')}`;
		}
		const args: DslValue[] = [];
		if (stream.expectPunct('(')) {
			if (!stream.expectPunct(')')) {
				while (true) {
					const arg = parseValue(stream);
					if (typeof arg === 'string') {
						return arg;
					}
					args.push(arg);
					if (stream.expectPunct(')')) {
						break;
					}
					if (!stream.expectPunct(',')) {
						return `expected "," or ")" in @${token.text}(...)`;
					}
				}
			}
		}
		steps.push({ step: token.text as ActionStepName, args });
		if (stream.expectPunct(']')) {
			break;
		}
		if (!stream.expectPunct(',')) {
			return 'expected "," or "]" between action steps';
		}
	}
	if (!stream.expectPunct(')')) {
		return 'expected ")" after Action([...])';
	}
	return { kind: 'action', steps };
}

// --- catalog validation --------------------------------------------------------

function typeLabel(type: ArgType): string {
	switch (type.kind) {
		case 'string':
			return 'a "string"';
		case 'number':
			return 'a number';
		case 'enum':
			return `one of ${type.values.map(value => `"${value}"`).join(' / ')}`;
		case 'binding':
			return 'a $variable binding';
		case 'action':
			return 'an Action([...])';
		case 'components':
			return 'an array of component references';
		case 'strings':
			return 'an array of strings';
		case 'cells':
			return 'an array of rows (arrays of string/number/boolean/null)';
	}
}

function checkArg(value: DslValue, type: ArgType): string | undefined {
	switch (type.kind) {
		case 'string':
			return value.kind === 'literal' && typeof value.value === 'string' ? undefined : `expected ${typeLabel(type)}`;
		case 'number':
			return value.kind === 'literal' && typeof value.value === 'number' ? undefined : `expected ${typeLabel(type)}`;
		case 'enum':
			return value.kind === 'literal' && typeof value.value === 'string' && type.values.includes(value.value) ? undefined : `expected ${typeLabel(type)}`;
		case 'binding':
			return value.kind === 'state' ? undefined : `expected ${typeLabel(type)}`;
		case 'action':
			return value.kind === 'action' ? undefined : `expected ${typeLabel(type)}`;
		case 'components':
			if (value.kind !== 'array' || value.items.some(item => item.kind !== 'ref' && item.kind !== 'component')) {
				return `expected ${typeLabel(type)}`;
			}
			return undefined;
		case 'strings':
			if (value.kind !== 'array' || value.items.some(item => item.kind !== 'literal' || typeof item.value !== 'string')) {
				return `expected ${typeLabel(type)}`;
			}
			return undefined;
		case 'cells':
			if (
				value.kind !== 'array' ||
				value.items.some(row => row.kind !== 'array' || row.items.some(cell => cell.kind !== 'literal'))
			) {
				return `expected ${typeLabel(type)}`;
			}
			return undefined;
	}
}

/** Validate one component call (recursively, for inline calls) against the catalog. Returns error text or undefined. */
function validateComponent(value: Extract<DslValue, { kind: 'component' }>, byName: ReadonlyMap<string, IComponentSpec>): { message: string; hint?: string } | undefined {
	const spec = byName.get(value.component);
	if (!spec) {
		return { message: `unknown component "${value.component}"`, hint: `catalog: ${[...byName.keys()].join(', ')}` };
	}
	const required = spec.args.filter(arg => !arg.optional).length;
	if (value.args.length < required || value.args.length > spec.args.length) {
		return {
			message: `${value.component} takes ${required === spec.args.length ? required : `${required}-${spec.args.length}`} argument(s), got ${value.args.length}`,
			hint: `${spec.name}(${spec.args.map(arg => arg.name + (arg.optional ? '?' : '')).join(', ')})`,
		};
	}
	for (let index = 0; index < value.args.length; index++) {
		const arg = value.args[index]!;
		const spec_ = spec.args[index]!;
		const problem = checkArg(arg, spec_.type);
		if (problem) {
			return { message: `${value.component} argument ${index} (${spec_.name}): ${problem}` };
		}
		if (arg.kind === 'component') {
			const nested = validateComponent(arg, byName);
			if (nested) {
				return nested;
			}
		}
		if (arg.kind === 'array') {
			for (const item of arg.items) {
				if (item.kind === 'component') {
					const nested = validateComponent(item, byName);
					if (nested) {
						return nested;
					}
				}
			}
		}
	}
	return undefined;
}

function collectRefs(value: DslValue, into: { refs: string[]; states: string[] }): void {
	if (value.kind === 'ref') {
		into.refs.push(value.name);
	} else if (value.kind === 'state') {
		into.states.push(value.name);
	} else if (value.kind === 'array') {
		for (const item of value.items) {
			collectRefs(item, into);
		}
	} else if (value.kind === 'component') {
		for (const arg of value.args) {
			collectRefs(arg, into);
		}
	} else if (value.kind === 'action') {
		for (const step of value.steps) {
			for (const arg of step.args) {
				collectRefs(arg, into);
			}
		}
	}
}

// --- program parse -------------------------------------------------------------

export function parseProgram(source: string, catalog: readonly IComponentSpec[]): IDslProgram {
	const byName = new Map(catalog.map(component => [component.name, component]));
	const raw = splitStatements(source);
	const errors: IDslError[] = [];
	const statements = new Map<string, IDslStatement>();

	for (const { text, line } of raw) {
		const tokens = tokenize(text);
		if (typeof tokens === 'string') {
			errors.push({ line, message: tokens });
			continue;
		}
		const stream = new TokenStream(tokens);
		const head = stream.next();
		const isState = head?.kind === 'state';
		if (!head || (head.kind !== 'ident' && !isState)) {
			errors.push({ line, message: 'a statement must start with `name =` or `$name =`', hint: 'e.g. root = Stack([...]) or $days = "7"' });
			continue;
		}
		if (!stream.expectPunct('=')) {
			errors.push({ line, statement: head.text, message: 'expected "=" after the statement name' });
			continue;
		}
		const value = parseValue(stream);
		if (typeof value === 'string') {
			errors.push({ line, statement: head.text, message: value });
			continue;
		}
		if (!stream.done()) {
			errors.push({ line, statement: head.text, message: 'unexpected trailing content after the statement value' });
			continue;
		}
		if (isState) {
			if (value.kind !== 'literal') {
				errors.push({ line, statement: `$${head.text}`, message: 'state declarations take a literal default, e.g. $days = "7"' });
				continue;
			}
			statements.set(`$${head.text}`, { name: `$${head.text}`, value, line, source: text });
			continue;
		}
		if (value.kind === 'component') {
			const problem = validateComponent(value, byName);
			if (problem) {
				errors.push({ line, statement: head.text, message: problem.message, ...(problem.hint ? { hint: problem.hint } : {}) });
				continue;
			}
		}
		// Last assignment wins (incremental-edit merge); first-definition order kept by Map insertion.
		statements.set(head.text, { name: head.text, value, line, source: text });
	}

	// Reference resolution: attributed to the REFERENCING statement (it is the
	// one the model must fix). Forward references are legal by construction —
	// this pass runs after the whole batch parsed.
	for (const statement of statements.values()) {
		const into = { refs: [] as string[], states: [] as string[] };
		collectRefs(statement.value, into);
		for (const ref of into.refs) {
			if (!statements.has(ref)) {
				errors.push({ line: statement.line, statement: statement.name, message: `reference "${ref}" is never defined`, hint: 'every referenced name needs its own `name = ...` statement' });
			}
		}
		for (const state of into.states) {
			if (!statements.has(`$${state}`)) {
				errors.push({ line: statement.line, statement: statement.name, message: `state "$${state}" is never declared`, hint: `declare it first: $${state} = <default>` });
			}
		}
	}
	if (!statements.has('root')) {
		errors.push({ line: 0, message: 'no `root = ...` statement — the surface has no mount point' });
	}

	return { statements, errors, attempts: raw.length };
}

/** The smoke metric: statements that survived into the merged program / attempts. */
export function statementYield(program: IDslProgram): { valid: number; attempts: number } {
	// A statement that parsed but carries a resolution error still counts
	// invalid — the surface would render a hole where it stands.
	const errorStatements = new Set(program.errors.map(error => error.statement).filter((name): name is string => name !== undefined));
	let valid = 0;
	for (const name of program.statements.keys()) {
		if (!errorStatements.has(name)) {
			valid++;
		}
	}
	return { valid, attempts: program.attempts };
}

/** Format errors the way the self-correction turn feeds them back. */
export function formatErrors(errors: readonly IDslError[]): string {
	return errors
		.map(error => `- line ${error.line}${error.statement ? ` (${error.statement})` : ''}: ${error.message}${error.hint ? ` — hint: ${error.hint}` : ''}`)
		.join('\n');
}
