// Builds dist/esm (ES modules) and dist/cjs (CommonJS), both with type declarations.
//   node tools/build.mjs
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const run = (...args) => execFileSync(process.execPath, [tsc, ...args], { stdio: 'inherit' });

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
run('-p', 'tsconfig.json');
run('-p', 'tsconfig.json', '--module', 'CommonJS', '--moduleResolution', 'Node10', '--verbatimModuleSyntax', 'false', '--outDir', 'dist/cjs');
writeFileSync(new URL('../dist/cjs/package.json', import.meta.url), '{ "type": "commonjs" }\n');
console.log('built dist/esm and dist/cjs');
