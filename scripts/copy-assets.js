// Copies non-TS assets (HTML, CSS, icons) into dist/ so the packaged app finds them.
const fs = require('fs');
const path = require('path');

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
  return true;
}

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

// Renderer-side assets (icons used in the UI)
if (copyDir(path.resolve('src/renderer/assets'), path.resolve('dist/renderer/assets'))) {
  console.log('Copied src/renderer/assets/ -> dist/renderer/assets/');
}

// Build-time icons (tray, app icon) need to be available at runtime.
// Copy them under dist/ so the main process can resolve them relative to __dirname.
if (copyDir(path.resolve('build/icons'), path.resolve('dist/icons'))) {
  console.log('Copied build/icons/ -> dist/icons/');
}

// Legacy resources folder (still copied for compatibility)
const resSrc = path.resolve('resources');
const resDest = path.resolve('dist/resources');
if (fs.existsSync(resSrc)) {
  fs.mkdirSync(resDest, { recursive: true });
  for (const f of fs.readdirSync(resSrc)) {
    fs.copyFileSync(path.join(resSrc, f), path.join(resDest, f));
  }
  console.log(`Copied resources/ -> dist/resources/`);
}