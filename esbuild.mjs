import * as esbuild from 'esbuild';

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
