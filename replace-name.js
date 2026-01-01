const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const SEARCH_REGEX = /code\s*nexus/gi;
const REPLACEMENT = 'CraftedCode Co.';
const IGNORE_DIRS = ['node_modules', '.git', '.next', 'dist', 'build'];

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
            // Ignore binary files or unreadable files
        }
    });
}

console.log('🔍 Replacing "CraftedCode Co." → "CraftedCode Co."');
walk(ROOT_DIR);
console.log('✅ Done.');