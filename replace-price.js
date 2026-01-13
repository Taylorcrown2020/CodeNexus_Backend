const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();

// Configuration
const OLD_PRICE = 199.00;
const NEW_PRICE = 199;

// Build regex patterns for all price formats
const OLD_INT = Math.floor(OLD_PRICE);
const OLD_CENTS = Math.round((OLD_PRICE % 1) * 100);
const NEW_INT = Math.floor(NEW_PRICE);
const NEW_CENTS = Math.round((NEW_PRICE % 1) * 100);

// Matches: $39.99, $39, 39.99, 39, €39.99, £39, etc.
const SEARCH_REGEX = new RegExp(
    `(\\$|€|£)?${OLD_INT}(\\.${OLD_CENTS.toString().padStart(2, '0')})?\\b`,
    'g'
);

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
                // Reset regex lastIndex
                SEARCH_REGEX.lastIndex = 0;
                
                const updated = content.replace(SEARCH_REGEX, (match, currencySymbol, cents) => {
                    const symbol = currencySymbol || '';
                    const newCents = cents ? `.${NEW_CENTS.toString().padStart(2, '0')}` : '';
                    return `${symbol}${NEW_INT}${newCents}`;
                });
                
                fs.writeFileSync(fullPath, updated, 'utf8');
                console.log(`✔ Updated: ${fullPath}`);
            }
        } catch {
            // Ignore binary or unreadable files
        }
    });
}

console.log(`🔍 Replacing "${OLD_INT}" variations → "${NEW_INT}" variations`);
walk(ROOT_DIR);
console.log('✅ Price replacement complete.');