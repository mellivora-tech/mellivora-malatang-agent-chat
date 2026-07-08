/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal markdown renderer for assistant replies. Builds DOM nodes directly
 * (no innerHTML), so model output can never inject markup. Covers the common
 * subset: headings, paragraphs, bold/italic/inline code, fenced code blocks,
 * unordered/ordered lists, tables, blockquotes and horizontal rules. Raw HTML
 * in the source renders as literal text by construction.
 */

export function renderMarkdown(source: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const lines = source.split('\n');
	let index = 0;

	while (index < lines.length) {
		const line = lines[index]!;
		const trimmed = line.trim();

		if (trimmed === '') {
			index++;
			continue;
		}

		// Fenced code block.
		if (trimmed.startsWith('```')) {
			const language = trimmed.slice(3).trim();
			const body: string[] = [];
			index++;
			while (index < lines.length && !lines[index]!.trim().startsWith('```')) {
				body.push(lines[index]!);
				index++;
			}
			index++; // closing fence
			const pre = document.createElement('pre');
			pre.className = 'md-code-block';
			if (language) {
				pre.dataset.language = language;
			}
			const code = document.createElement('code');
			code.textContent = body.join('\n');
			pre.appendChild(code);
			fragment.appendChild(pre);
			continue;
		}

		// Heading.
		const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		if (heading) {
			const level = heading[1]!.length;
			const element = document.createElement(`h${level}`);
			element.className = 'md-heading';
			element.appendChild(renderInline(heading[2]!));
			fragment.appendChild(element);
			index++;
			continue;
		}

		// Horizontal rule.
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			fragment.appendChild(document.createElement('hr'));
			index++;
			continue;
		}

		// Blockquote.
		if (trimmed.startsWith('>')) {
			const quoteLines: string[] = [];
			while (index < lines.length && lines[index]!.trim().startsWith('>')) {
				quoteLines.push(lines[index]!.trim().replace(/^>\s?/, ''));
				index++;
			}
			const quote = document.createElement('blockquote');
			quote.appendChild(renderMarkdown(quoteLines.join('\n')));
			fragment.appendChild(quote);
			continue;
		}

		// Table: a header row of cells followed by a |---|-style separator.
		if (trimmed.startsWith('|') && index + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[index + 1]!.trim()) && lines[index + 1]!.includes('-')) {
			const headerCells = splitTableRow(trimmed);
			index += 2;
			const rows: string[][] = [];
			while (index < lines.length && lines[index]!.trim().startsWith('|')) {
				rows.push(splitTableRow(lines[index]!.trim()));
				index++;
			}
			fragment.appendChild(renderTable(headerCells, rows));
			continue;
		}

		// Lists (one nesting level via leading indentation).
		const listMatch = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
		if (listMatch) {
			const { element, consumed } = renderList(lines, index);
			fragment.appendChild(element);
			index += consumed;
			continue;
		}

		// Paragraph: join consecutive plain lines. The current line is consumed
		// unconditionally — it may LOOK like a block start that failed to parse
		// (e.g. a lone "|" table row mid-stream); skipping it without advancing
		// would loop forever.
		const paragraphLines: string[] = [trimmed];
		index++;
		while (index < lines.length) {
			const candidate = lines[index]!;
			const candidateTrimmed = candidate.trim();
			if (
				candidateTrimmed === '' ||
				candidateTrimmed.startsWith('```') ||
				candidateTrimmed.startsWith('#') ||
				candidateTrimmed.startsWith('>') ||
				candidateTrimmed.startsWith('|') ||
				/^(\s*)([-*+]|\d+[.)])\s+/.test(candidate) ||
				/^(-{3,}|\*{3,}|_{3,})$/.test(candidateTrimmed)
			) {
				break;
			}
			paragraphLines.push(candidateTrimmed);
			index++;
		}
		const paragraph = document.createElement('p');
		paragraph.appendChild(renderInline(paragraphLines.join('\n')));
		fragment.appendChild(paragraph);
	}

	return fragment;
}

function splitTableRow(row: string): string[] {
	return row
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map(cell => cell.trim());
}

function renderTable(header: readonly string[], rows: readonly string[][]): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.className = 'md-table-wrap';
	const table = document.createElement('table');
	table.className = 'md-table';

	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	for (const cell of header) {
		const th = document.createElement('th');
		th.appendChild(renderInline(cell));
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = document.createElement('tbody');
	for (const cells of rows) {
		const tr = document.createElement('tr');
		for (let i = 0; i < header.length; i++) {
			const td = document.createElement('td');
			td.appendChild(renderInline(cells[i] ?? ''));
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);

	wrapper.appendChild(table);
	return wrapper;
}

function renderList(lines: readonly string[], start: number): { element: HTMLElement; consumed: number } {
	const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start]!)!;
	const baseIndent = first[1]!.length;
	const ordered = /\d/.test(first[2]!);
	const list = document.createElement(ordered ? 'ol' : 'ul');
	list.className = 'md-list';

	let index = start;
	let currentItem: HTMLLIElement | undefined;
	while (index < lines.length) {
		const line = lines[index]!;
		const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (!match) {
			// Indented continuation text belongs to the current item.
			if (currentItem && line.trim() !== '' && /^\s+/.test(line)) {
				currentItem.appendChild(document.createElement('br'));
				currentItem.appendChild(renderInline(line.trim()));
				index++;
				continue;
			}
			break;
		}

		const indent = match[1]!.length;
		if (indent > baseIndent && currentItem) {
			const nested = renderList(lines, index);
			currentItem.appendChild(nested.element);
			index += nested.consumed;
			continue;
		}
		if (indent < baseIndent) {
			break;
		}

		currentItem = document.createElement('li');
		currentItem.appendChild(renderInline(match[3]!));
		list.appendChild(currentItem);
		index++;
	}

	return { element: list, consumed: index - start };
}

/** Inline spans: `code`, **bold**, *italic*, [text](url) — built as nodes, never parsed as HTML. */
function renderInline(text: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	// Tokenize by inline code first so markers inside backticks stay literal.
	const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
	let last = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		if (match.index > last) {
			fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
		}
		const token = match[0];
		if (token.startsWith('`')) {
			const code = document.createElement('code');
			code.className = 'md-inline-code';
			code.textContent = token.slice(1, -1);
			fragment.appendChild(code);
		} else if (token.startsWith('**')) {
			const strong = document.createElement('strong');
			strong.appendChild(renderInline(token.slice(2, -2)));
			fragment.appendChild(strong);
		} else if (token.startsWith('*')) {
			const em = document.createElement('em');
			em.appendChild(renderInline(token.slice(1, -1)));
			fragment.appendChild(em);
		} else {
			// Link: render the text, keep the target visible on hover. Navigation is
			// deliberately disabled — this is a chat surface, not a browser.
			const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
			const anchor = document.createElement('span');
			anchor.className = 'md-link';
			anchor.title = link[2]!;
			anchor.textContent = link[1]!;
			fragment.appendChild(anchor);
		}
		last = pattern.lastIndex;
	}
	if (last < text.length) {
		fragment.appendChild(document.createTextNode(text.slice(last)));
	}
	return fragment;
}
