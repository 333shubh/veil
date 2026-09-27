// Bundles the demo. The protocol code is used unchanged: imports of src/crypto.ts resolve to src/crypto.browser.ts,
// node:crypto to a shim over Web Crypto, and Buffer to the buffer package. The same bundling produces the Node soak run
// (demo/dist/soak.mjs), so the gate exercises exactly the code the browser runs. `--serve` serves the demo on :8000.
import { build, context, type BuildOptions, type Plugin } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const browserCrypto: Plugin = {
  name: 'browser-crypto',
  setup(b) {
    b.onResolve({ filter: /(^|\/)crypto\.ts$/ }, (args) =>
      resolve(args.resolveDir, args.path) === here('../src/crypto.ts') ? { path: here('../src/crypto.browser.ts') } : undefined,
    );
    b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: here('./shims/node-crypto.ts') }));
  },
};

const common: BuildOptions = { bundle: true, format: 'esm', plugins: [browserCrypto], inject: [here('./shims/buffer.ts')], logLevel: 'warning' };

mkdirSync(here('./dist'), { recursive: true });
copyFileSync(here('./index.html'), here('./dist/index.html'));
await build({
  ...common,
  entryPoints: [here('./soak.ts'), here('./shard-thread.ts')],
  outdir: here('./dist'),
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  external: ['node:fs', 'node:os', 'node:worker_threads'],
});
const browser: BuildOptions = { ...common, entryPoints: [here('./main.ts'), here('./worker.ts'), here('./shard-worker.ts')], outdir: here('./dist'), platform: 'browser', minify: true };
if (process.argv.includes('--serve')) {
  const ctx = await context(browser);
  const { port } = await ctx.serve({ servedir: here('./dist'), port: 8000 });
  console.log(`demo on http://localhost:${port}`);
} else await build(browser);
