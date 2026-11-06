# express-leak-detector (The Zombie Request Finder)

[![npm version](https://img.shields.io/npm/v/express-leak-detector?color=cb3837&style=flat-square)](https://www.npmjs.com/package/express-leak-detector)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-@dev--on--repeat/express--leak--detector-blue?logo=github&style=flat-square)](https://github.com/Dev-On-Repeat/express-leak-detector/packages)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](LICENSE)

Stop letting forgotten next() or res.send() calls hang your server. This lightweight Express.js utility detects zombie requests in real-time. It maps your middleware execution paths and prints a clean, color-coded breadcrumb trace that pinpoints the exact filename, line, and column of the leak.

A robust, developer-friendly diagnostic tool for Express.js that detects **zombie requests** (hanging requests caused by forgotten `res.send()` or `next()` calls). It tracks execution paths and outputs a clean, color-coded **execution breadcrumb trace** pointing to the exact filename, line, and column of the hanging middleware.

---

## The Invisible Pain Point

In Express, a single misplaced `if/else` block where a developer forgets to respond or call `next()` causes the socket to hang indefinitely. It drains memory, consumes file descriptors, and eventually triggers unexplainable server timeouts under production loads. 

While typical APM tools (Datadog, New Relic) can report that a route is slow or timing out, they do not isolate *why* or show *which* middleware halted execution. `express-leak-detector` solves this by tracing the execution path and highlighting the exact line of code where the chain stopped.

---

##  Features

-  **Line-Level Diagnostics**: Captures call stack locations at registration time to tell you exactly where the culprit middleware was defined.
-  **Zero-Config Streaming Safety**: Automatically overrides response stream methods (`res.write` and `res.writeHead`) to prevent false positives for Server-Sent Events (SSE) and streamed responses.
-  **Event Loop Safe**: Uses `unref` on active timeout timers so they do not block Node's process exit or test suites.
-  **Custom Reporters**: Exposes an `onLeak` callback to redirect warning payloads to your APM tool (e.g. Sentry, Slack alerts, Datadog).
-  **Comprehensive Coverage**: Hooks into `router.use`, `router.param`, and all HTTP verb routes (like `router.get`, `router.post`, etc.).

---

##  Installation

**From npm:**
```bash
npm install express-leak-detector
```

**From GitHub Packages:**
```bash
npm install @dev-on-repeat/express-leak-detector
```

---

##  Quick Start

Initialize the leak detector **before** registering any routes or middlewares:

```javascript
const express = require('express');
const { initLeakDetector } = require('express-leak-detector');

const app = express();

// Initialize the leak detector globally (threshold: 5 seconds)
initLeakDetector({
  timeout: 5000
});

// Middlewares will be auto-monitored!
app.use((req, res, next) => {
  next();
});

// A route that hangs!
app.get('/api/users', (req, res, next) => {
  if (req.query.admin) {
    res.send({ role: 'admin' });
  } else {
    // Oops! Forgotten next() or res.send() here!
    // The request will hang, and a warning will log after 5 seconds
  }
});

app.listen(3000);
```

### 📋 Example Terminal Output

When `/api/users` hangs, `express-leak-detector` will output this to the terminal:

```ansi
  [EXPRESS LEAK DETECTOR] ZOMBIE REQUEST DETECTED
================================================================
Request Method: GET
Request URL:    /api/users
Threshold:      5000ms
Hanging At:     <anonymous>
File Path:      C:\Users\ypran\Desktop\Backend\server.js:18:5
Active For:     5005ms+

Execution Breadcrumbs:
   ✓ query (C:\Users\ypran\Desktop\Backend\server.js:8:5) -> next() (12ms)
   ✓ expressInit (C:\Users\ypran\Desktop\Backend\server.js:8:5) -> next() (2ms)
   ✓ <anonymous> (C:\Users\ypran\Desktop\Backend\server.js:12:3) -> next() (1ms)
   ⚠ <anonymous> (C:\Users\ypran\Desktop\Backend\server.js:17:5) -> HUNG (5005ms+)
================================================================
```

---

##  Configuration Options

Initialize the detector by calling `initLeakDetector(options)`:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeout` | `number` | `5000` | The threshold in milliseconds before a request is considered a zombie. |
| `logger` | `Object` | `console` | An object implementing `.error()` (e.g. `console`, `winston`). |
| `excludePaths` | `Array<string \| RegExp>` | `[]` | Exact paths, prefixes, or regex patterns to bypass tracking (e.g. `['/socket.io', /^\/assets/ ]`). |
| `onLeak` | `Function` | `null` | A custom callback function called when a leak is detected. Prevents default logging. |

###  Example: Custom APM Reporting (Slack / Sentry)

Instead of logging to the terminal, you can send the trace payloads to Sentry or Slack:

```javascript
initLeakDetector({
  timeout: 10000,
  onLeak: (leakInfo, req, res) => {
    // send alert to Slack or APM
    Sentry.captureMessage(`Zombie Request Halted: ${leakInfo.method} ${leakInfo.url}`, {
      level: 'warning',
      extra: {
        timeout: leakInfo.timeout,
        hangingAt: leakInfo.activeTrace,
        breadcrumbs: leakInfo.breadcrumbs
      }
    });
  }
});
```

The `leakInfo` object has the following format:
```json
{
  "url": "/api/users",
  "method": "GET",
  "timeout": 5000,
  "activeTrace": {
    "name": "<anonymous>",
    "file": "C:/Backend/server.js",
    "line": 18,
    "column": 5,
    "startTime": 1790435889000,
    "duration": 5003
  },
  "breadcrumbs": [
    {
      "name": "query",
      "file": "C:/Backend/server.js",
      "line": 8,
      "column": 5,
      "duration": 12,
      "status": "next_called"
    },
    {
      "name": "<anonymous>",
      "file": "C:/Backend/server.js",
      "line": 18,
      "column": 5,
      "duration": 5003,
      "status": "hung"
    }
  ]
}
```

---

##  How It Works Under the Hood

1. **Monkey Patching**:
   On initialization, the library patches Express's `Router.use`, `Router.param`, and verb methods (`Route.prototype[method]`). This intercepts all middleware/handler registrations without modifying your server logic.
2. **Location Capture**:
   During middleware registration, it captures a lightweight V8 call stack trace to extract the exact filename, line, and column where the middleware was registered.
3. **Timer Array & Cleanups**:
   Each request receives a unique identifier. Every time a new middleware in the chain executes, the request's timeout timer resets.
   - If the request is completed (`finish` or `close` event on response), the timer is cleared.
   - If a streaming response starts writing (`writeHead` or `write`), the timer is automatically canceled to avoid false alarms.
   - If the timer ticks past the threshold, the leak reporter triggers with the recorded history.

##  License

MIT
