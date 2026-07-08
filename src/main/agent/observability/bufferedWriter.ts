/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A tiny buffered writer, modelled on Claude Code's `bufferedWriter`: batch
 * lines and flush on a timer or when the buffer grows past a threshold, with an
 * `immediate` mode for synchronous per-line writes. `flush()`/`dispose()` drain
 * synchronously so nothing is lost on `process.exit()`. The `writeFn` is
 * expected to be synchronous (e.g. `appendFileSync`), which keeps durability
 * simple: once flushed, the bytes are on disk.
 */
export interface IBufferedWriter {
	write(line: string): void;
	flush(): void;
	dispose(): void;
}

export interface IBufferedWriterOptions {
	readonly writeFn: (content: string) => void;
	readonly flushIntervalMs?: number;
	/** Flush once the pending buffer reaches this many characters. */
	readonly maxBufferChars?: number;
	/** Write every line straight through — for debugging where losing a line is worse than the cost. */
	readonly immediate?: boolean;
}

export function createBufferedWriter(options: IBufferedWriterOptions): IBufferedWriter {
	const flushIntervalMs = options.flushIntervalMs ?? 1000;
	const maxBufferChars = options.maxBufferChars ?? 64 * 1024;
	let buffer = '';
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const flush = (): void => {
		clearTimer();
		if (buffer === '') {
			return;
		}
		const content = buffer;
		buffer = '';
		try {
			options.writeFn(content);
		} catch {
			// A logging failure must never break the app.
		}
	};

	const write = (line: string): void => {
		if (options.immediate) {
			try {
				options.writeFn(line);
			} catch {
				// Ignore.
			}
			return;
		}
		buffer += line;
		if (buffer.length >= maxBufferChars) {
			flush();
			return;
		}
		if (timer === undefined) {
			timer = setTimeout(flush, flushIntervalMs);
			// Don't keep the process alive just to flush logs.
			timer.unref?.();
		}
	};

	return {
		write,
		flush,
		dispose: () => {
			flush();
			clearTimer();
		},
	};
}
