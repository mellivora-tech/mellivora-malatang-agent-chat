/**---------------------------------------------------------------------------------------------
 *  Generate platform app icons from the SVG source.
 *
 *  Source:  resources/logo/logo-app.svg   (ember "M" on a dark rounded square)
 *  Output:  build/icon.icns  (macOS)   build/icon.ico  (Windows)   build/icon.png  (Linux, 512px)
 *
 *  SVG -> PNG via @resvg/resvg-js (bundled native binaries, no system deps).
 *  PNG -> .ico via png-to-ico. PNG -> .icns via the macOS `iconutil` tool when available.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svgPath = join(root, 'resources/logo/logo-app.svg');
const buildDir = join(root, 'build');

/** Rasterize the source SVG to a square PNG buffer of the given pixel size. */
async function renderPng(svg, size) {
	const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
	return resvg.render().asPng();
}

async function main() {
	const svg = await readFile(svgPath, 'utf8');
	await mkdir(buildDir, { recursive: true });

	// Linux: a single 512px PNG.
	await writeFile(join(buildDir, 'icon.png'), await renderPng(svg, 512));

	// Windows: multi-resolution .ico.
	const icoSizes = [16, 24, 32, 48, 64, 128, 256];
	const icoPngs = await Promise.all(icoSizes.map(s => renderPng(svg, s)));
	await writeFile(join(buildDir, 'icon.ico'), await pngToIco(icoPngs));

	// macOS: build an .iconset then convert with `iconutil` (present on macOS only).
	const iconset = join(buildDir, 'icon.iconset');
	await rm(iconset, { recursive: true, force: true });
	await mkdir(iconset, { recursive: true });
	const icnsSpecs = [
		[16, 'icon_16x16.png'],
		[32, 'icon_16x16@2x.png'],
		[32, 'icon_32x32.png'],
		[64, 'icon_32x32@2x.png'],
		[128, 'icon_128x128.png'],
		[256, 'icon_128x128@2x.png'],
		[256, 'icon_256x256.png'],
		[512, 'icon_256x256@2x.png'],
		[512, 'icon_512x512.png'],
		[1024, 'icon_512x512@2x.png'],
	];
	await Promise.all(icnsSpecs.map(async ([size, name]) => writeFile(join(iconset, name), await renderPng(svg, size))));

	try {
		await execFileAsync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')]);
		await rm(iconset, { recursive: true, force: true });
		console.log('icons: wrote build/icon.png, build/icon.ico, build/icon.icns');
	} catch {
		console.warn('icons: wrote build/icon.png and build/icon.ico; skipped .icns (iconutil not available — run on macOS)');
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
