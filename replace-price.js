const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const SEARCH_REGEX = /\$499\.99/g;
const REPLACEMENT = '$299.99';

const IGNORE_DIRS = [
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    'coverage'
];

function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!IGNORE_DIRS.includes(entry.name)) {
                walk(fullPath);
            }
            return;
        }

        if (!entry.isFile()) return;

        try {
            const content = fs.readFileSync(fullPath, 'utf8');

            if (SEARCH_REGEX.test(content)) {
                const updated = content.replace(SEARCH_REGEX, REPLACEMENT);
                fs.writeFileSync(fullPath, updated, 'utf8');
                console.log(`✔ Updated: ${fullPath}`);
            }
        } catch {
            // Ignore binary or unreadable files
        }
    });
}

console.log('🔍 Replacing "$299.99" → "$299.99"');
walk(ROOT_DIR);
console.log('✅ Price replacement complete.');