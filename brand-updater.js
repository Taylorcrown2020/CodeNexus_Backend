const fs = require('fs');
const path = require('path');

// Define all replacements
const replacements = [
  // Company Name variations
  { from: /CraftedCode Co\./g, to: 'Diamondback Coding' },
  { from: /CraftedCode/g, to: 'Diamondback Coding' },
  { from: /craftedcodeco/g, to: 'diamondbackcoding' },
  
  // Email addresses
  { from: /contact@craftedcodeco\.com/g, to: 'contact@diamondbackcoding.com' },
  
  // URLs and domains
  { from: /https:\/\/craftedcodeco\.com/g, to: 'https://diamondbackcoding.com' },
  { from: /craftedcodeco\.com/g, to: 'diamondbackcoding.com' },
  
  // Social media handles
  { from: /@craftedcodeco/g, to: '@diamondbackcoding' },
  { from: /\/craftedcodeco/g, to: '/diamondbackcoding' },
];

// Get the file to process from command line argument or use default
const inputFile = process.argv[2] || 'index.html';
const outputFile = process.argv[3] || 'index_updated.html';

console.log('🚀 Brand Updater Script');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Check if input file exists
if (!fs.existsSync(inputFile)) {
  console.error(`❌ Error: File "${inputFile}" not found!`);
  console.log('\n💡 Usage: node brand-updater.js [input-file] [output-file]');
  console.log('   Example: node brand-updater.js index.html index_updated.html\n');
  process.exit(1);
}

// Read the file
console.log(`📖 Reading file: ${inputFile}`);
let content = fs.readFileSync(inputFile, 'utf8');
const originalSize = content.length;

// Track changes
const changes = [];

// Apply all replacements
replacements.forEach(({ from, to }) => {
  const matches = content.match(from);
  const count = matches ? matches.length : 0;
  
  if (count > 0) {
    content = content.replace(from, to);
    changes.push({
      from: from.source.replace(/\\/g, ''),
      to: to,
      count: count
    });
  }
});

// Write the updated file
fs.writeFileSync(outputFile, content, 'utf8');

// Display results
console.log('\n✅ Processing complete!\n');
console.log('📊 Changes Made:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (changes.length === 0) {
  console.log('   No changes were needed.\n');
} else {
  changes.forEach(change => {
    console.log(`   ✓ ${change.count}x: "${change.from}" → "${change.to}"`);
  });
  
  const totalChanges = changes.reduce((sum, c) => sum + c.count, 0);
  console.log(`\n   📈 Total: ${totalChanges} replacements made`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`💾 Saved to: ${outputFile}`);
console.log(`📏 Original size: ${(originalSize / 1024).toFixed(2)} KB`);
console.log(`📏 New size: ${(content.length / 1024).toFixed(2)} KB`);
console.log('\n⚠️  Remember to also update:');
console.log('   • Logo image files');
console.log('   • Domain registration');
console.log('   • Social media accounts');
console.log('   • Google Analytics ID');
console.log('   • SSL certificates (if domain changes)\n');