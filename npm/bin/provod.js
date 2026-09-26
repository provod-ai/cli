#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');

if (process.platform === 'win32') {
  console.error('Windows support is currently unavailable. Use macOS or Linux.');
  process.exit(1);
}

const executable = join(__dirname, '..', 'vendor', 'provod');
const child = spawn(executable, process.argv.slice(2), {
  shell: false,
  stdio: 'inherit',
  windowsHide: false,
});

const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
const handlers = new Map();
for (const signal of forwardedSignals) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

function removeHandlers() {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}

child.once('error', (error) => {
  removeHandlers();
  if (error.code === 'ENOENT') {
    console.error('Provod native executable is missing; reinstall @provod-ai/cli without --ignore-scripts.');
  } else {
    console.error(`Unable to launch the Provod native executable: ${error.message}`);
  }
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  removeHandlers();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code === null ? 1 : code;
});
