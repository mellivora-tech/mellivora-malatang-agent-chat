/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { LspTransport } from './lspTransport.js';
import { type Language, type ServerOverrides, languageForPath, resolveServer } from './serverResolver.js';

/** Milliseconds to wait for the initialize handshake before giving up on a server. */
const INIT_TIMEOUT_MS = 20_000;
/** jdtls indexes asynchronously; an early query returns empty. Retry a bounded number of times. */
const QUERY_RETRIES = 6;
const QUERY_RETRY_MS = 1_500;

const LANGUAGE_ID: Record<Language, string> = { java: 'java', typescript: 'typescript', vue: 'vue' };

/** LSP is 0-based; we report 1-based lines to the model. */
interface IPosition {
	readonly line: number;
	readonly character: number;
}
interface IRange {
	readonly start: IPosition;
	readonly end: IPosition;
}
interface IDocumentSymbol {
	readonly name: string;
	readonly kind: number;
	readonly range: IRange;
	readonly selectionRange?: IRange;
	readonly children?: readonly IDocumentSymbol[];
}
interface ISymbolInformation {
	readonly name: string;
	readonly kind: number;
	readonly location: { readonly uri: string; readonly range: IRange };
}

/** The definition of one symbol, sliced from its source. */
export interface ISymbolHit {
	readonly path: string;
	readonly startLine: number; // 1-based, inclusive
	readonly endLine: number; // 1-based, inclusive
	readonly text: string;
}

export interface ILanguageServerManager {
	readSymbol(symbol: string, fileHint?: string): Promise<ISymbolHit | { readonly error: string }>;
	dispose(): Promise<void>;
}

interface IServer {
	readonly child: ChildProcessWithoutNullStreams;
	readonly transport: LspTransport;
	readonly open: Set<string>; // uris we've sent didOpen for
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function createLanguageServerManager(roots: readonly string[], overrides?: ServerOverrides): ILanguageServerManager {
	// One server per language, rooted at the primary root. Lazily spawned.
	const servers = new Map<Language, IServer | Promise<IServer>>();
	const root = roots[0] ?? process.cwd();

	async function startServer(language: Language): Promise<IServer> {
		const spec = resolveServer(language, overrides);
		if (!spec) {
			throw new Error(`no ${language} language server found (tried PATH + defaults); install one or configure it to use read_symbol on ${language} files`);
		}
		const child = spawn(spec.command, [...spec.args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
		child.on('error', () => {
			/* surfaced via transport rejection */
		});
		const transport = new LspTransport(
			child.stdin,
			child.stdout,
			// Server→client requests: answer the ones that block initialization.
			(method, params) => {
				if (method === 'workspace/configuration') {
					const items = (params as { items?: unknown[] })?.items ?? [];
					return items.map(() => null); // one (null) config entry per requested item
				}
				return null; // registerCapability / workDoneProgress/create / unknown → null result
			},
			() => {
				/* notifications (progress, diagnostics, logs) — not needed for symbol lookup */
			},
		);
		const server: IServer = { child, transport, open: new Set() };

		const initialize = transport.request('initialize', {
			processId: process.pid,
			rootUri: pathToFileURL(root).toString(),
			workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: 'root' }],
			capabilities: {
				textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
				workspace: { symbol: {}, configuration: true, workspaceFolders: true },
			},
		});
		const timed = await Promise.race([initialize.then(() => 'ok' as const), delay(INIT_TIMEOUT_MS).then(() => 'timeout' as const)]);
		if (timed === 'timeout') {
			transport.dispose('initialize timed out');
			child.kill();
			throw new Error(`${language} language server did not initialize within ${INIT_TIMEOUT_MS / 1000}s`);
		}
		transport.notify('initialized', {});
		return server;
	}

	async function ensureServer(language: Language): Promise<IServer> {
		const existing = servers.get(language);
		if (existing) {
			return existing;
		}
		const starting = startServer(language);
		servers.set(language, starting);
		try {
			const server = await starting;
			servers.set(language, server);
			return server;
		} catch (error) {
			servers.delete(language); // let a later call retry a failed start
			throw error;
		}
	}

	async function ensureOpen(server: IServer, absPath: string): Promise<string> {
		const uri = pathToFileURL(absPath).toString();
		if (server.open.has(uri)) {
			return uri;
		}
		const text = await readFile(absPath, 'utf8');
		const language = languageForPath(absPath);
		server.transport.notify('textDocument/didOpen', {
			textDocument: { uri, languageId: language ? LANGUAGE_ID[language] : 'plaintext', version: 1, text },
		});
		server.open.add(uri);
		return uri;
	}

	/** documentSymbol with retry — an early call against a still-indexing server returns []. */
	async function documentSymbols(server: IServer, uri: string): Promise<Array<IDocumentSymbol | ISymbolInformation>> {
		for (let attempt = 0; attempt <= QUERY_RETRIES; attempt++) {
			const result = (await server.transport.request('textDocument/documentSymbol', { textDocument: { uri } })) as Array<IDocumentSymbol | ISymbolInformation> | null;
			if (result && result.length > 0) {
				return result;
			}
			if (attempt < QUERY_RETRIES) {
				await delay(QUERY_RETRY_MS);
			}
		}
		return [];
	}

	async function workspaceSymbols(server: IServer, query: string): Promise<ISymbolInformation[]> {
		for (let attempt = 0; attempt <= QUERY_RETRIES; attempt++) {
			const result = (await server.transport.request('workspace/symbol', { query })) as ISymbolInformation[] | null;
			if (result && result.length > 0) {
				return result;
			}
			if (attempt < QUERY_RETRIES) {
				await delay(QUERY_RETRY_MS);
			}
		}
		return [];
	}

	/** Depth-first search of a (possibly hierarchical) symbol tree for an exact-name match, preferring one whose range contains `near`. */
	function findByName(symbols: ReadonlyArray<IDocumentSymbol | ISymbolInformation>, name: string, near?: IPosition): IRange | undefined {
		let fallback: IRange | undefined;
		const visit = (nodes: ReadonlyArray<IDocumentSymbol | ISymbolInformation>): IRange | undefined => {
			for (const node of nodes) {
				const range = 'location' in node ? node.location.range : node.range;
				if (node.name === name) {
					if (!near || contains(range, near)) {
						return range;
					}
					fallback ??= range;
				}
				const children = 'children' in node ? node.children : undefined;
				if (children && children.length > 0) {
					const hit = visit(children);
					if (hit) {
						return hit;
					}
				}
			}
			return undefined;
		};
		return visit(symbols) ?? fallback;
	}

	function contains(range: IRange, pos: IPosition): boolean {
		if (pos.line < range.start.line || pos.line > range.end.line) {
			return false;
		}
		if (pos.line === range.start.line && pos.character < range.start.character) {
			return false;
		}
		if (pos.line === range.end.line && pos.character > range.end.character) {
			return false;
		}
		return true;
	}

	async function slice(uri: string, range: IRange): Promise<ISymbolHit> {
		const path = uriToPath(uri);
		const lines = (await readFile(path, 'utf8')).split('\n');
		const startLine = range.start.line;
		const endLine = Math.min(range.end.line, lines.length - 1);
		return { path, startLine: startLine + 1, endLine: endLine + 1, text: lines.slice(startLine, endLine + 1).join('\n') };
	}

	async function readSymbol(symbol: string, fileHint?: string): Promise<ISymbolHit | { error: string }> {
		try {
			// A file hint pins the language and the first place to look.
			if (fileHint) {
				const language = languageForPath(fileHint);
				if (!language) {
					return { error: `read_symbol supports .java, .ts/.tsx/.js/.jsx and .vue files; "${fileHint}" is none of these` };
				}
				const server = await ensureServer(language);
				const uri = await ensureOpen(server, fileHint);
				const range = findByName(await documentSymbols(server, uri), symbol);
				if (range) {
					return slice(uri, range);
				}
				// Not defined in the hinted file — fall back to a workspace search on the same server.
				const hit = await workspaceThenBody(server, symbol);
				return hit ?? { error: `symbol "${symbol}" not found from ${fileHint} or its ${language} workspace` };
			}

			// No hint: try each language whose server is available, take the first hit.
			const errors: string[] = [];
			for (const language of ['typescript', 'java', 'vue'] as const) {
				let server: IServer;
				try {
					server = await ensureServer(language);
				} catch (error) {
					errors.push(error instanceof Error ? error.message : String(error));
					continue;
				}
				const hit = await workspaceThenBody(server, symbol);
				if (hit) {
					return hit;
				}
			}
			return { error: errors.length > 0 ? errors.join('; ') : `symbol "${symbol}" not found in any language server's workspace (pass a file path to narrow it down)` };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** workspace/symbol to find the file+approx location, then documentSymbol there for the FULL body range. */
	async function workspaceThenBody(server: IServer, symbol: string): Promise<ISymbolHit | undefined> {
		const candidates = (await workspaceSymbols(server, symbol)).filter(candidate => candidate.name === symbol);
		const best = candidates[0];
		if (!best) {
			return undefined;
		}
		const path = uriToPath(best.location.uri);
		const uri = await ensureOpen(server, path);
		// Prefer the full-body range from documentSymbol; fall back to the workspace hit's own range.
		const range = findByName(await documentSymbols(server, uri), symbol, best.location.range.start) ?? best.location.range;
		return slice(uri, range);
	}

	async function dispose(): Promise<void> {
		const entries = [...servers.values()];
		servers.clear();
		await Promise.all(
			entries.map(async entry => {
				try {
					const server = await entry;
					// Best-effort graceful shutdown, then hard kill.
					await Promise.race([server.transport.request('shutdown', null).catch(() => undefined), delay(1_000)]);
					server.transport.notify('exit', null);
					server.transport.dispose('manager disposed');
					server.child.kill();
				} catch {
					// A server that never started has nothing to tear down.
				}
			}),
		);
	}

	return { readSymbol, dispose };
}

function uriToPath(uri: string): string {
	if (uri.startsWith('file://')) {
		return decodeURIComponent(new URL(uri).pathname);
	}
	return uri;
}
