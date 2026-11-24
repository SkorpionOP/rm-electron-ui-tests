const { exec, spawn } = require('child_process');
const path = require('path');
const http = require('http');

const appDir = 'C:\\Users\\omkar\\Downloads\\SUTRA AI\\Sutra-AI-APP';
const electronBin = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');

console.log('1. Launching Google Meet in Chrome on screen...');
exec('start chrome.exe "https://meet.google.com/new"');

console.log('2. Launching real RM App window on desktop...');
const env = { ...process.env, RM_TEST_MODE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBin, [appDir], { env, windowsHide: false });

child.stdout.on('data', d => {
  const s = d.toString().trim();
  if (s.includes('Stealth controller listening') || s.includes('Restored saved window') || s.includes('Shortcuts')) {
    console.log('  [RM App Event]', s);
  }
});

setTimeout(() => {
  http.get('http://127.0.0.1:48999', res => {
    console.log('3. RM Stealth Controller verified active on port 48999! HTTP code:', res.statusCode);
    child.kill();
    process.exit(0);
  }).on('error', err => {
    console.error('Error reaching RM controller:', err.message);
    child.kill();
    process.exit(1);
  });
}, 5000);
