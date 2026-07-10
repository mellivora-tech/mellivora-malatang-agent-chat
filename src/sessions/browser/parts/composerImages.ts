/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { IPendingImage } from '../../services/sessions/common/sessionsProvider.js';

/**
 * Image attachments for the composer textareas: paste an image, drop one onto
 * the composer, or pick via a file input. Pending images render as a thumbnail
 * strip above the input (each with a remove button) and are held as raw base64
 * until send — persistence happens provider-side once the session ref exists.
 */

const ACCEPTED_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface IImageInstallOptions {
	readonly input: HTMLTextAreaElement;
	/** Drop target — the whole composer form, so a drop anywhere on it lands. */
	readonly dropTarget: HTMLElement;
	/** Called whenever the pending set changes (enable/disable send, resize…). */
	readonly onDidChange?: () => void;
}

export interface IImageController extends IDisposable {
	getImages(): IPendingImage[];
	hasImages(): boolean;
	/** Open a file picker (wire to a "+" button). */
	pick(): void;
	/** Drop all pending images (call after a successful send or on session switch). */
	reset(): void;
}

export function installImageAttachments(options: IImageInstallOptions): IImageController {
	const { input, dropTarget } = options;
	const pending: { image: IPendingImage; element: HTMLElement }[] = [];

	const strip = document.createElement('div');
	strip.className = 'composer-image-strip';
	strip.hidden = true;
	input.before(strip);

	const picker = document.createElement('input');
	picker.type = 'file';
	picker.accept = [...ACCEPTED_MEDIA_TYPES].join(',');
	picker.multiple = true;
	picker.hidden = true;
	strip.after(picker);

	const notifyChange = (): void => {
		strip.hidden = pending.length === 0;
		options.onDidChange?.();
	};

	const removeImage = (entry: { image: IPendingImage; element: HTMLElement }): void => {
		const index = pending.indexOf(entry);
		if (index !== -1) {
			pending.splice(index, 1);
			entry.element.remove();
			notifyChange();
		}
	};

	const addImage = (image: IPendingImage): void => {
		if (pending.length >= MAX_IMAGES) {
			return;
		}
		const thumb = document.createElement('div');
		thumb.className = 'composer-image-thumb';
		const img = document.createElement('img');
		img.src = `data:${image.mediaType};base64,${image.data}`;
		img.alt = 'Attached image';
		thumb.appendChild(img);
		const remove = document.createElement('button');
		remove.className = 'composer-image-remove';
		remove.type = 'button';
		remove.title = 'Remove image';
		remove.setAttribute('aria-label', 'Remove image');
		remove.textContent = '×';
		thumb.appendChild(remove);
		strip.appendChild(thumb);
		const entry = { image, element: thumb };
		remove.addEventListener('click', () => removeImage(entry));
		pending.push(entry);
		notifyChange();
	};

	const addFile = (file: File | Blob): void => {
		const mediaType = file.type;
		if (!ACCEPTED_MEDIA_TYPES.has(mediaType) || file.size > MAX_IMAGE_BYTES || pending.length >= MAX_IMAGES) {
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const url = typeof reader.result === 'string' ? reader.result : '';
			const base64 = url.slice(url.indexOf(',') + 1);
			if (base64) {
				addImage({ data: base64, mediaType });
			}
		};
		reader.readAsDataURL(file);
	};

	const onPaste = (event: ClipboardEvent): void => {
		const items = event.clipboardData?.items ?? [];
		let found = false;
		for (const item of items) {
			if (item.kind === 'file' && ACCEPTED_MEDIA_TYPES.has(item.type)) {
				const file = item.getAsFile();
				if (file) {
					found = true;
					addFile(file);
				}
			}
		}
		if (found) {
			// Don't also paste the image's filename/text representation.
			event.preventDefault();
		}
	};

	const onDragOver = (event: DragEvent): void => {
		if ([...(event.dataTransfer?.items ?? [])].some(item => item.kind === 'file')) {
			event.preventDefault();
			dropTarget.classList.add('composer-drop-active');
		}
	};
	const onDragLeave = (): void => dropTarget.classList.remove('composer-drop-active');
	const onDrop = (event: DragEvent): void => {
		dropTarget.classList.remove('composer-drop-active');
		const files = event.dataTransfer?.files;
		if (!files || files.length === 0) {
			return;
		}
		event.preventDefault();
		for (const file of files) {
			addFile(file);
		}
	};

	const onPick = (): void => {
		for (const file of picker.files ?? []) {
			addFile(file);
		}
		picker.value = '';
	};

	input.addEventListener('paste', onPaste);
	dropTarget.addEventListener('dragover', onDragOver);
	dropTarget.addEventListener('dragleave', onDragLeave);
	dropTarget.addEventListener('drop', onDrop);
	picker.addEventListener('change', onPick);

	const disposable = toDisposable(() => {
		input.removeEventListener('paste', onPaste);
		dropTarget.removeEventListener('dragover', onDragOver);
		dropTarget.removeEventListener('dragleave', onDragLeave);
		dropTarget.removeEventListener('drop', onDrop);
		picker.removeEventListener('change', onPick);
		strip.remove();
		picker.remove();
	});

	return {
		getImages: () => pending.map(entry => entry.image),
		hasImages: () => pending.length > 0,
		pick: () => picker.click(),
		reset: () => {
			pending.splice(0, pending.length);
			strip.replaceChildren();
			notifyChange();
		},
		dispose: () => disposable.dispose(),
	};
}
