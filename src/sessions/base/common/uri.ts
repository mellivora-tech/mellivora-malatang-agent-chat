/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';

const empty = '';
const uriExpression = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

export interface UriComponents {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;
}

export interface UriChange {
	readonly scheme?: string;
	readonly authority?: string | null;
	readonly path?: string | null;
	readonly query?: string | null;
	readonly fragment?: string | null;
}

export class URI implements UriComponents {
	static isUri(thing: unknown): thing is URI {
		return thing instanceof URI;
	}

	static from(components: UriComponents): URI {
		return new URI(
			components.scheme,
			components.authority,
			components.path,
			components.query,
			components.fragment
		);
	}

	static parse(value: string): URI {
		const match = uriExpression.exec(value);
		if (!match) {
			throw new Error(`Invalid URI: ${value}`);
		}

		return new URI(
			match[2] ?? empty,
			decodeURIComponent(match[4] ?? empty),
			decodeURIComponent(match[5] ?? empty),
			decodeURIComponent(match[7] ?? empty),
			decodeURIComponent(match[9] ?? empty)
		);
	}

	static file(fsPath: string): URI {
		const normalized = path.resolve(fsPath).replace(/\\/g, '/');
		const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
		return new URI('file', empty, prefixed, empty, empty);
	}

	static revive(data: UriComponents | URI | undefined | null): URI | undefined {
		if (!data) {
			return undefined;
		}

		return URI.isUri(data) ? data : URI.from(data);
	}

	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;

	constructor(
		scheme: string,
		authority: string = empty,
		uriPath: string = empty,
		query: string = empty,
		fragment: string = empty
	) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = normalizeUriPath(scheme, authority, uriPath);
		this.query = query;
		this.fragment = fragment;
	}

	get fsPath(): string {
		if (this.scheme !== 'file') {
			return this.path;
		}

		const decoded = decodeURIComponent(this.path);
		if (process.platform === 'win32') {
			const windowsPath = decoded.replace(/\//g, '\\');
			return this.authority.length > 0 ? `\\\\${this.authority}${windowsPath}` : windowsPath.replace(/^\\([a-zA-Z]:)/, '$1');
		}

		return decoded;
	}

	with(change: UriChange): URI {
		return new URI(
			change.scheme ?? this.scheme,
			change.authority === undefined ? this.authority : change.authority ?? empty,
			change.path === undefined ? this.path : change.path ?? empty,
			change.query === undefined ? this.query : change.query ?? empty,
			change.fragment === undefined ? this.fragment : change.fragment ?? empty
		);
	}

	toJSON(): UriComponents {
		return {
			scheme: this.scheme,
			authority: this.authority,
			path: this.path,
			query: this.query,
			fragment: this.fragment
		};
	}

	toString(): string {
		const scheme = this.scheme.length > 0 ? `${this.scheme}:` : empty;
		const authority = this.authority.length > 0 ? `//${encodeURIComponent(this.authority)}` : empty;
		const uriPath = encodeURI(this.path);
		const query = this.query.length > 0 ? `?${encodeURIComponent(this.query)}` : empty;
		const fragment = this.fragment.length > 0 ? `#${encodeURIComponent(this.fragment)}` : empty;
		return `${scheme}${authority}${uriPath}${query}${fragment}`;
	}
}

export function joinPath(base: URI, ...segments: string[]): URI {
	const normalizedSegments = segments.map(segment => segment.replace(/^\/+|\/+$/g, ''));
	const nextPath = path.posix.join(base.path, ...normalizedSegments);
	return base.with({ path: nextPath.startsWith('/') ? nextPath : `/${nextPath}` });
}

function normalizeUriPath(scheme: string, authority: string, uriPath: string): string {
	if (uriPath.length === 0) {
		return authority.length > 0 || isSlashPrefixedScheme(scheme) ? '/' : empty;
	}

	if ((authority.length > 0 || isSlashPrefixedScheme(scheme)) && !uriPath.startsWith('/')) {
		return `/${uriPath}`;
	}

	return uriPath;
}

function isSlashPrefixedScheme(scheme: string): boolean {
	return scheme === 'file' || scheme === 'http' || scheme === 'https';
}
