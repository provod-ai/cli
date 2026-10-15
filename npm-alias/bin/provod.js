#!/usr/bin/env node
/* global require, __filename, process, console */
'use strict';

const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const requireFromHere = createRequire(__filename);
const scopedLauncher = requireFromHere.resolve('@provod-ai/cli/bin/provod.js');
const child = spawn(process.execPath, [scopedLauncher, ...process.argv.slice(2)], {
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
  console.error(`Unable to launch the Provod CLI: ${error.message}`);
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
