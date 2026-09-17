import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function markdownFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return target.endsWith('.md') ? [target] : [];
  return fs.readdirSync(target).flatMap(name => markdownFiles(path.join(target, name)));
}
const files = ['README.md', 'AGENTS.md', 'docs', '.agents/skills', 'packages/core/README.md']
  .flatMap(name => markdownFiles(path.join(root, name)));
const errors = [];
for (const file of files) {
  const body = fs.readFileSync(file, 'utf8').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) continue;
    const filename = decodeURIComponent(target.split('#')[0]);
    if (!fs.existsSync(path.resolve(path.dirname(fs.realpathSync(file)), filename))) {
      errors.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}
if (errors.length) throw new Error(`Broken documentation links:\n${errors.join('\n')}`);
console.log(`Documentation links resolve (${files.length} Markdown files).`);
