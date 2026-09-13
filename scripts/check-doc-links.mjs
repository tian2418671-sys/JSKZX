// Doc link checker: verifies that every relative markdown link in the repo's docs resolves to an existing file.
// Usage: node scripts/check-doc-links.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist_new', 'web', 'models']);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            walk(path.join(dir, e.name), out);
        } else if (e.name.endsWith('.md')) {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

const files = walk(ROOT);
const missing = [];
let checked = 0;

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const target = m[1];
        if (/^(https?:|mailto:|#|data:)/i.test(target)) continue;
        const clean = decodeURIComponent(target.split('#')[0]);
        if (!clean) continue;
        checked++;
        const abs = path.resolve(path.dirname(file), clean);
        if (!fs.existsSync(abs)) {
            missing.push(`${path.relative(ROOT, file)}  ->  ${target}`);
        }
    }
}

console.log(`markdown files : ${files.length}`);
console.log(`relative links : ${checked}`);
if (missing.length === 0) {
    console.log('ALL RESOLVE');
} else {
    console.log(`BROKEN (${missing.length}):`);
    for (const x of missing) console.log('  ' + x);
    process.exitCode = 1;
}
