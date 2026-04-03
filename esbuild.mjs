import * as esbuild from 'esbuild';
import * as fs from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
};

const editorVendorConfig = {
  entryPoints: ['media/editor/vendor.js'],
  bundle: true,
  outfile: 'dist/media/editor/vendor.js',
  format: 'iife',
  globalName: 'CodeNodesEditorVendor',
  platform: 'browser',
  target: 'es2022',
  minify: production,
};

const graphVendorConfig = {
  entryPoints: ['media/graph/vendor.js'],
  bundle: true,
  outfile: 'dist/media/graph/vendor.js',
  format: 'iife',
  globalName: 'CodeNodesGraphVendor',
  platform: 'browser',
  target: 'es2022',
  minify: production,
};

// Copy highlight.js theme into dist so the editor webview can load it as a local resource
fs.mkdirSync('dist/media/editor', { recursive: true });
fs.copyFileSync(
  'node_modules/highlight.js/styles/atom-one-dark.min.css',
  'dist/media/editor/hljs-theme.css'
);

// Copy dictionary files into dist so the extension process can load them at runtime
fs.copyFileSync('node_modules/dictionary-en/index.aff', 'dist/en_US.aff');
fs.copyFileSync('node_modules/dictionary-en/index.dic', 'dist/en_US.dic');

if (watch) {
  const [extCtx, editorCtx, graphCtx] = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(editorVendorConfig),
    esbuild.context(graphVendorConfig),
  ]);
  await Promise.all([extCtx.watch(), editorCtx.watch(), graphCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(editorVendorConfig),
    esbuild.build(graphVendorConfig),
  ]);
  console.log('Build complete.');
}
