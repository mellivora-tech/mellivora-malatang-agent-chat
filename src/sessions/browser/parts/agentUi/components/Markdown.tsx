/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type JSX } from 'react';
import { renderMarkdown } from '../../markdownRenderer.js';

export interface IMarkdownProps {
	readonly text: string;
	readonly className?: string | undefined;
}

/**
 * Bridges the shared (non-React) markdown renderer into a React subtree — it
 * returns a DocumentFragment, not a string, so this mounts it imperatively
 * into a ref rather than reimplementing markdown rendering for React.
 */
export function Markdown(props: IMarkdownProps): JSX.Element {
	const { text, className } = props;
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		ref.current?.replaceChildren(renderMarkdown(text));
	}, [text]);

	return <div className={className ? `${className} conversation-markdown` : 'conversation-markdown'} ref={ref} />;
}
