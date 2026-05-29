import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const target = process.argv[2] || 'all';
const root = path.dirname(new URL(import.meta.url).pathname);

async function ensureDir(p) { if (!existsSync(p)) await mkdir(p, { recursive: true }); }

async function buildPlugin() {
  const outdir = path.join(root, 'plugin/dist');
  await ensureDir(outdir);

  // Figma sandbox code — runs in the plugin VM, no DOM.
  await build({
    entryPoints: [path.join(root, 'plugin/src/code.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2017',
    outfile: path.join(outdir, 'code.js'),
    logLevel: 'info',
  });

  // UI-side capture runner — bundled into a string we inline into ui.html.
  // Figma's plugin UI must be a single HTML file (loaded via `__html__`),
  // so we can't ship a separate <script src="…"> bundle.
  const runner = await build({
    entryPoints: [path.join(root, 'plugin/src/capture-runner.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    write: false,
    logLevel: 'info',
  });
  const runnerJs = runner.outputFiles[0].text;

  const uiTemplate = await readFile(path.join(root, 'plugin/src/ui.html'), 'utf8');
  // Pass the replacement as a function: `String.prototype.replace` treats `$&`,
  // `$$`, `$1`, … in a string replacement specially. The bundled runner has
  // legitimate `$` characters (template literals, regex anchors, JSX runtime
  // helpers) and a string replacement was silently corrupting them.
  const injected = uiTemplate.replace(
    '<!-- CAPTURE_RUNNER_BUNDLE -->',
    () => `<script>\n${runnerJs}\n</script>`,
  );
  if (injected === uiTemplate) {
    throw new Error('ui.html is missing the <!-- CAPTURE_RUNNER_BUNDLE --> placeholder');
  }
  await writeFile(path.join(outdir, 'ui.html'), injected);
  console.log('✓ plugin built');
}

if (target === 'plugin' || target === 'all') {
  await buildPlugin();
} else {
  throw new Error(`Unknown build target: ${target}`);
}
