// Copies non-TS assets (HTML, CSS, icons) into dist/ so the packaged app finds them.
const fs = require('fs');
const path = require('path');

const copies = [
  { from: 'src/renderer/index.html', to: 'dist/renderer/index.html' },
  { from: 'src/renderer/styles.css', to: 'dist/renderer/styles.css' },
];

for (const { from, to } of copies) {
  const src = path.resolve(from);
  const dest = path.resolve(to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied ${from} -> ${to}`);
}

// Copy resources folder if present
const resSrc = path.resolve('resources');
const resDest = path.resolve('dist/resources');
if (fs.existsSync(resSrc)) {
  fs.mkdirSync(resDest, { recursive: true });
  for (const f of fs.readdirSync(resSrc)) {
    fs.copyFileSync(path.join(resSrc, f), path.join(resDest, f));
  }
  console.log(`Copied resources/ -> dist/resources/`);
}
