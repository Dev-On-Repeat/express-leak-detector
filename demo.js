const express = require('express');
const { initLeakDetector } = require('./index');

// Initialize with a 2-second timeout for the demo
initLeakDetector({
  timeout: 2000
});

const app = express();

// A simple logging middleware
function requestLogger(req, res, next) {
  console.log(`[Demo] Received ${req.method} ${req.url}`);
  next();
}

// A middleware that works
function authMock(req, res, next) {
  setTimeout(() => {
    console.log('[Demo] Auth mock verified');
    next();
  }, 100);
}

// A middleware that hangs
function brokenMiddleware(req, res, next) {
  console.log('[Demo] Entering broken middleware... and we forget to call next()!');
  // Forgot res.send or next()!
}

app.use(requestLogger);

app.get('/ok', authMock, (req, res) => {
  res.send({ status: 'All good!' });
});

app.get('/zombie', authMock, brokenMiddleware, (req, res) => {
  res.send({ status: 'Will never reach here' });
});

const port = 3000;
app.listen(port, () => {
  console.log(`\n======================================================`);
  console.log(`Demo Server running on http://localhost:${port}`);
  console.log(`======================================================`);
  console.log(`1. Visit http://localhost:${port}/ok      -> Normal request (no leak)`);
  console.log(`2. Visit http://localhost:${port}/zombie  -> Zombie request (leaks in 2s)`);
  console.log(`======================================================\n`);
});
