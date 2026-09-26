const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const base = 'https://raw.githubusercontent.com/gultar/browser-os/main/';
const assets = [
  ['css/variables.css', 'vendor/original-browser-os/css/variables.css'],
  ['css/window.css', 'css/window.css'],
  ['js/external/winbox.bundle.min.js', 'vendor/original-browser-os/js/external/winbox.bundle.min.js'],
];

function download(url, destination) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'browser-os-local-dashboard' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, destination).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const target = path.join(ROOT, destination);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.concat(chunks));
        console.log(`[original Browser-OS] ${destination}`);
        resolve();
      });
    }).on('error', reject);
  });
}

(async () => {
  try {
    for (const [source, destination] of assets) {
      await download(base + source, destination);
    }
    console.log('Original Browser-OS window assets synchronized exactly from gultar/browser-os main.');
  } catch (err) {
    console.warn('\nCould not synchronize the original Browser-OS assets automatically.');
    console.warn(err.message);
    console.warn('The project will keep its bundled fallback. Run `npm run sync-original-style` when online.\n');
    // Do not break npm install: npm WinBox remains as a runtime fallback.
    process.exitCode = 0;
  }
})();
