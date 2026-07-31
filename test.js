const express = require('express');
const http = require('http');
const { initLeakDetector } = require('./index');

// Keep track of detected leaks in our tests
const detectedLeaks = [];

// Initialize detector with 100ms timeout for fast testing
initLeakDetector({
  timeout: 150,
  onLeak: (leakInfo) => {
    detectedLeaks.push(leakInfo);
  },
  excludePaths: ['/api/excluded']
});

// Create Express App
const app = express();

// Helper middleware to simulate work
function dummyMiddleware(req, res, next) {
  setTimeout(next, 20);
}

// 1. Normal route
app.get('/api/normal', dummyMiddleware, (req, res) => {
  res.send({ status: 'ok' });
});

// 2. Leaked route (hanging handler)
app.get('/api/leaked-handler', dummyMiddleware, (req, res) => {
  // Developer forgot to call res.send or next
  // This will hang!
});

// 3. Hanging middleware route
function hangingMiddleware(req, res, next) {
  // Forget to call next() or res.send()
}
app.get('/api/leaked-middleware', dummyMiddleware, hangingMiddleware, (req, res) => {
  res.send({ status: 'never reached' });
});

// 4. Excluded route (which hangs, but should be ignored)
app.get('/api/excluded', (req, res) => {
  // Hangs, but is in excludePaths
});

// 5. Streaming route (uses write/writeHead, should not leak)
app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write('chunk 1\n');
  setTimeout(() => {
    res.write('chunk 2\n');
    setTimeout(() => {
      res.end('done\n');
    }, 100);
  }, 100);
});

// 6. Router param middleware route
app.param('userId', function userIdParam(req, res, next, id) {
  // Let's pretend we fetch user and call next
  setTimeout(next, 10);
});
app.param('hangingId', function hangingParam(req, res, next, id) {
  // Hangs!
});

app.get('/users/:userId', (req, res) => {
  res.send({ user: req.params.userId });
});

app.get('/hanging/:hangingId', (req, res) => {
  res.send({ status: 'never reached' });
});

// 7. Error handling middleware route
app.get('/api/error-trigger', (req, res, next) => {
  next(new Error('test-error'));
});

// Hanging error handler
app.use((err, req, res, next) => {
  // We handle the error but forget to respond or next
  // Should hang and detect leak in error handler!
});

// Start server on dynamic port
const server = app.listen(0, () => {
  const port = server.address().port;
  console.log(`Test server running on port ${port}`);

  runTests(port);
});

async function runTests(port) {
  const request = (path) => {
    return new Promise((resolve) => {
      http.get(`http://localhost:${port}${path}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }).on('error', () => {
        // Suppress client connection errors if we force close
        resolve({ error: true });
      });
    });
  };

  try {
    console.log('\n--- Starting Tests ---\n');

    // Test 1: Normal execution
    console.log('Testing normal route...');
    const res1 = await request('/api/normal');
    if (res1.statusCode !== 200) throw new Error('Normal route failed');
    await sleep(200); // Wait to ensure no leak was registered
    assertEqual(detectedLeaks.length, 0, 'Normal route registered a leak, but shouldn\'t have');
    console.log('✅ Normal route passed');

    // Test 2: Leaked handler
    console.log('Testing leaked handler route...');
    request('/api/leaked-handler');
    await sleep(250); // Wait for timeout (150ms) to trigger leak
    assertEqual(detectedLeaks.length, 1, 'Leaked handler did not register a leak');
    assertEqual(detectedLeaks[0].url, '/api/leaked-handler', 'Incorrect URL logged');
    assertEqual(detectedLeaks[0].activeTrace.name, '<anonymous>', 'Incorrect active trace name');
    // It is defined in this file (test.js), verify line number (around line 32)
    assertMatches(detectedLeaks[0].activeTrace.file, 'test.js', 'Hanging file should match test.js');
    console.log('✅ Leaked handler route passed');

    // Test 3: Hanging middleware
    detectedLeaks.length = 0; // reset
    console.log('Testing hanging middleware route...');
    request('/api/leaked-middleware');
    await sleep(250);
    assertEqual(detectedLeaks.length, 1, 'Hanging middleware did not register a leak');
    assertEqual(detectedLeaks[0].activeTrace.name, 'hangingMiddleware', 'Incorrect hanging middleware name');
    const breadcrumbs = detectedLeaks[0].breadcrumbs;
    assertEqual(breadcrumbs.length, 4, 'Should have exactly four breadcrumbs');
    assertEqual(breadcrumbs[0].name, 'query', 'First breadcrumb should be query');
    assertEqual(breadcrumbs[1].name, 'expressInit', 'Second breadcrumb should be expressInit');
    assertEqual(breadcrumbs[2].name, 'dummyMiddleware', 'Third breadcrumb should be dummyMiddleware');
    assertEqual(breadcrumbs[2].status, 'next_called', 'Third breadcrumb status should be next_called');
    assertEqual(breadcrumbs[3].name, 'hangingMiddleware', 'Fourth breadcrumb should be hangingMiddleware');
    assertEqual(breadcrumbs[3].status, 'hung', 'Fourth breadcrumb status should be hung');
    console.log('✅ Hanging middleware route passed');

    // Test 4: Excluded route
    detectedLeaks.length = 0;
    console.log('Testing excluded route...');
    request('/api/excluded');
    await sleep(250);
    assertEqual(detectedLeaks.length, 0, 'Excluded route registered a leak');
    console.log('✅ Excluded route passed');

    // Test 5: Streaming route
    detectedLeaks.length = 0;
    console.log('Testing streaming route...');
    const streamRes = await request('/api/stream');
    assertEqual(streamRes.statusCode, 200, 'Stream request failed');
    await sleep(250);
    assertEqual(detectedLeaks.length, 0, 'Streaming route registered a leak');
    console.log('✅ Streaming route passed');

    // Test 6: Router param middleware
    detectedLeaks.length = 0;
    console.log('Testing normal param middleware...');
    const userRes = await request('/users/123');
    assertEqual(userRes.statusCode, 200, 'User route failed');
    await sleep(250);
    assertEqual(detectedLeaks.length, 0, 'Normal param route registered a leak');
    console.log('✅ Normal param route passed');

    console.log('Testing hanging param middleware...');
    request('/hanging/999');
    await sleep(250);
    assertEqual(detectedLeaks.length, 1, 'Hanging param route did not register a leak');
    assertEqual(detectedLeaks[0].activeTrace.name, 'param:hangingParam', 'Incorrect hanging param middleware name');
    console.log('✅ Hanging param route passed');

    // Test 7: Error handling middleware leak
    detectedLeaks.length = 0;
    console.log('Testing hanging error handler...');
    request('/api/error-trigger');
    await sleep(250);
    assertEqual(detectedLeaks.length, 1, 'Hanging error handler did not register a leak');
    assertEqual(detectedLeaks[0].activeTrace.name, '<anonymous>', 'Incorrect hanging error handler name');
    console.log('✅ Hanging error handler passed');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ TEST SUITE FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected [${expected}] but got [${actual}]`);
  }
}

function assertMatches(actual, pattern, message) {
  if (!actual.includes(pattern)) {
    throw new Error(`${message}: expected [${actual}] to contain [${pattern}]`);
  }
}
