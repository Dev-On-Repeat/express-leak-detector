const express = require('express');
const http = require('http');

// Symbols for private properties on req
const TIMER_KEY = Symbol('express-leak-detector-timer');
const CONTEXT_KEY = Symbol('express-leak-detector-context');

let isInitialized = false;

// Global settings
const globalOptions = {
  timeout: 5000,
  logger: console,
  onLeak: null,
  excludePaths: []
};

/**
 * Parses the call stack to find where the middleware was registered.
 * Excludes internal Node.js files, express files, and our package files.
 */
function getCallerInfo() {
  const obj = {};
  Error.captureStackTrace(obj, getCallerInfo);
  const stack = obj.stack.split('\n');

  for (let i = 1; i < stack.length; i++) {
    const line = stack[i];
    if (!line) continue;

    const match = line.match(/\(([^)]+)\)/) || line.match(/at\s+(.+)$/);
    if (match) {
      const pathStr = match[1];
      const parts = pathStr.split(':');
      let file, lineNo, colNo;

      if (parts.length >= 3) {
        if (parts[0].length === 1 && /^[a-zA-Z]$/.test(parts[0])) {
          file = parts[0] + ':' + parts[1];
          lineNo = parseInt(parts[2], 10);
          colNo = parseInt(parts[3], 10);
        } else {
          file = parts.slice(0, -2).join(':');
          lineNo = parseInt(parts[parts.length - 2], 10);
          colNo = parseInt(parts[parts.length - 1], 10);
        }
      } else {
        continue;
      }

      // Normalize file path to forward slashes for cross-platform compatibility
      const normalizedFile = file.replace(/\\/g, '/');

      // Filter out internals (only exclude detector's own files and node/npm internals)
      const isInternal = normalizedFile.includes('express-leak-detector/lib/') ||
                         normalizedFile.endsWith('express-leak-detector/index.js') ||
                         normalizedFile.includes('node_modules') ||
                         normalizedFile.includes('node:internal') ||
                         normalizedFile.startsWith('internal/');

      if (!isInternal && file !== 'unknown') {
        return { file, line: lineNo, column: colNo };
      }
    }
  }

  return { file: 'unknown', line: 0, column: 0 };
}

/**
 * Checks if the URL matches any path in excludePaths.
 */
function shouldExclude(url) {
  if (!globalOptions.excludePaths || globalOptions.excludePaths.length === 0) {
    return false;
  }
  return globalOptions.excludePaths.some(pattern => {
    if (typeof pattern === 'string') {
      return url.startsWith(pattern) || url === pattern;
    }
    if (pattern instanceof RegExp) {
      return pattern.test(url);
    }
    return false;
  });
}

/**
 * Gets or creates the tracking context on the request.
 */
function getOrCreateRequestContext(req, res) {
  const url = req.originalUrl || req.url;
  if (shouldExclude(url)) {
    return null;
  }

  if (!req[CONTEXT_KEY]) {
    req[CONTEXT_KEY] = {
      breadcrumbs: [],
      activeTrace: null,
      startTime: Date.now(),
      url: url,
      method: req.method,
      res: res
    };

    const cleanup = () => {
      clearRequestTimer(req);
      const ctx = req[CONTEXT_KEY];
      if (ctx && ctx.activeTrace) {
        ctx.activeTrace.endTime = Date.now();
        ctx.activeTrace.duration = ctx.activeTrace.endTime - ctx.activeTrace.startTime;
        ctx.activeTrace.status = 'response_sent';
        ctx.activeTrace = null;
      }
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);
  }
  return req[CONTEXT_KEY];
}

/**
 * Clears any active leak timer on the request.
 */
function clearRequestTimer(req) {
  if (req[TIMER_KEY]) {
    clearTimeout(req[TIMER_KEY]);
    req[TIMER_KEY] = null;
  }
}

/**
 * Starts or refreshes the leak timer.
 */
function resetRequestTimer(req, reqContext) {
  clearRequestTimer(req);

  const timer = setTimeout(() => {
    handleLeak(req, reqContext);
  }, globalOptions.timeout);

  if (timer.unref) {
    timer.unref();
  }

  req[TIMER_KEY] = timer;
}

/**
 * Default reporter for when a leak is detected.
 */
function defaultOnLeak(leakInfo) {
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const green = '\x1b[32m';
  const cyan = '\x1b[36m';
  const gray = '\x1b[90m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  const logger = globalOptions.logger || console;

  logger.error(`\n${red}${bold}⚠️  [EXPRESS LEAK DETECTOR] ZOMBIE REQUEST DETECTED${reset}`);
  logger.error(`${gray}================================================================${reset}`);
  logger.error(`${bold}Request Method:${reset} ${cyan}${leakInfo.method}${reset}`);
  logger.error(`${bold}Request URL:${reset}    ${cyan}${leakInfo.url}${reset}`);
  logger.error(`${bold}Threshold:${reset}      ${yellow}${leakInfo.timeout}ms${reset}`);

  if (leakInfo.activeTrace) {
    const active = leakInfo.activeTrace;
    logger.error(`${bold}Hanging At:${reset}     ${red}${bold}${active.name}${reset}`);
    logger.error(`${bold}File Path:${reset}      ${yellow}${active.file}:${active.line}:${active.column}${reset}`);
    logger.error(`${bold}Active For:${reset}     ${red}${active.duration}ms+${reset}`);
  } else {
    logger.error(`${bold}Hanging At:${reset}     ${red}Unknown (Middleware execution completed but request was not ended)${reset}`);
  }

  logger.error(`\n${bold}Execution Breadcrumbs:${reset}`);
  leakInfo.breadcrumbs.forEach((crumb, index) => {
    const isLast = index === leakInfo.breadcrumbs.length - 1;
    const icon = isLast ? ` ${red}⚠${reset}` : ` ${green}✓${reset}`;
    const statusText = isLast ? `${red}HUNG (${crumb.duration}ms+)${reset}` : `${green}next() (${crumb.duration}ms)${reset}`;
    const name = `${bold}${crumb.name}${reset}`;
    const location = `${gray}(${crumb.file}:${crumb.line}:${crumb.column})${reset}`;
    logger.error(`  ${icon} ${name} ${location} -> ${statusText}`);
  });
  logger.error(`${gray}================================================================\n${reset}`);
}

/**
 * Triggers when a request has timed out.
 */
function handleLeak(req, reqContext) {
  // Construct trace report payload
  const activeTrace = reqContext.activeTrace;
  const now = Date.now();

  if (activeTrace) {
    activeTrace.duration = now - activeTrace.startTime;
    activeTrace.status = 'hung';
  }

  const leakInfo = {
    url: reqContext.url,
    method: reqContext.method,
    timeout: globalOptions.timeout,
    activeTrace: activeTrace ? {
      name: activeTrace.name,
      file: activeTrace.file,
      line: activeTrace.line,
      column: activeTrace.column,
      startTime: activeTrace.startTime,
      duration: activeTrace.duration
    } : null,
    breadcrumbs: reqContext.breadcrumbs.map(b => ({
      name: b.name,
      file: b.file,
      line: b.line,
      column: b.column,
      duration: b.duration || (now - b.startTime),
      status: b.status
    }))
  };

  if (typeof globalOptions.onLeak === 'function') {
    globalOptions.onLeak(leakInfo, req, reqContext.res);
  } else {
    defaultOnLeak(leakInfo);
  }
}

/**
 * Wraps a single middleware function.
 */
function wrapMiddleware(fn, fileInfo) {
  if (fn.__isWrapped) return fn;

  const wrappedName = fn.name || 'anonymous';

  // Standard middleware wrapper (3 arguments)
  const standardWrapper = function(req, res, next) {
    return runWrapped(fn, fileInfo, this, arguments, req, res, next);
  };

  // Error middleware wrapper (4 arguments)
  const errorWrapper = function(err, req, res, next) {
    return runWrapped(fn, fileInfo, this, arguments, req, res, next);
  };

  // Express checks fn.length to identify error middlewares (must be 4 arguments)
  const wrapper = fn.length === 4 ? errorWrapper : standardWrapper;

  Object.defineProperty(wrapper, 'name', { value: wrappedName });
  wrapper.__isWrapped = true;
  wrapper.originalFn = fn;
  return wrapper;
}

/**
 * Recursively wraps an array of middlewares.
 */
function wrapMiddlewareArray(arr, fileInfo) {
  return arr.map(item => {
    if (typeof item === 'function') {
      const isRouter = typeof item.handle === 'function' && typeof item.use === 'function';
      return isRouter ? item : wrapMiddleware(item, fileInfo);
    } else if (Array.isArray(item)) {
      return wrapMiddlewareArray(item, fileInfo);
    }
    return item;
  });
}

/**
 * Core wrapper execution logic.
 */
function runWrapped(fn, fileInfo, context, originalArgs, req, res, next) {
  if (!req || !res) {
    return fn.apply(context, originalArgs);
  }

  const reqContext = getOrCreateRequestContext(req, res);
  if (!reqContext) {
    return fn.apply(context, originalArgs);
  }

  const traceItem = {
    name: fn.name || '<anonymous>',
    file: fileInfo.file,
    line: fileInfo.line,
    column: fileInfo.column,
    startTime: Date.now(),
    endTime: null,
    duration: null,
    status: 'pending'
  };

  reqContext.activeTrace = traceItem;
  reqContext.breadcrumbs.push(traceItem);

  resetRequestTimer(req, reqContext);

  const nextIdx = fn.length === 4 ? 3 : 2;
  const originalNext = originalArgs[nextIdx];

  const wrappedNext = function(err) {
    traceItem.endTime = Date.now();
    traceItem.duration = traceItem.endTime - traceItem.startTime;
    traceItem.status = 'next_called';

    if (reqContext.activeTrace === traceItem) {
      reqContext.activeTrace = null;
    }

    resetRequestTimer(req, reqContext);

    if (typeof originalNext === 'function') {
      return originalNext(err);
    }
  };

  originalArgs[nextIdx] = wrappedNext;

  try {
    return fn.apply(context, originalArgs);
  } catch (err) {
    clearRequestTimer(req);
    throw err;
  }
}

/**
 * Core wrapper execution logic specifically for Router.param.
 */
function runWrappedParam(fn, fileInfo, context, originalArgs, req, res, next) {
  if (!req || !res) {
    return fn.apply(context, originalArgs);
  }

  const reqContext = getOrCreateRequestContext(req, res);
  if (!reqContext) {
    return fn.apply(context, originalArgs);
  }

  const traceItem = {
    name: `param:${fn.name || '<anonymous>'}`,
    file: fileInfo.file,
    line: fileInfo.line,
    column: fileInfo.column,
    startTime: Date.now(),
    endTime: null,
    duration: null,
    status: 'pending'
  };

  reqContext.activeTrace = traceItem;
  reqContext.breadcrumbs.push(traceItem);

  resetRequestTimer(req, reqContext);

  const originalNext = originalArgs[2];

  const wrappedNext = function(err) {
    traceItem.endTime = Date.now();
    traceItem.duration = traceItem.endTime - traceItem.startTime;
    traceItem.status = 'next_called';

    if (reqContext.activeTrace === traceItem) {
      reqContext.activeTrace = null;
    }

    resetRequestTimer(req, reqContext);

    if (typeof originalNext === 'function') {
      return originalNext(err);
    }
  };

  originalArgs[2] = wrappedNext;

  try {
    return fn.apply(context, originalArgs);
  } catch (err) {
    clearRequestTimer(req);
    throw err;
  }
}

/**
 * Patch Router.use to intercept and wrap registered middlewares.
 */
function patchRouter() {
  const originalUse = express.Router.use;
  if (originalUse.__isPatched) return;

  express.Router.use = function(path, ...args) {
    let startIdx = 0;
    if (typeof path === 'function') {
      startIdx = 0;
    } else if (typeof path === 'string' || path instanceof RegExp || Array.isArray(path)) {
      startIdx = 1;
    } else {
      startIdx = 0;
    }

    const callerInfo = getCallerInfo();

    for (let i = startIdx; i < arguments.length; i++) {
      const fn = arguments[i];
      if (typeof fn === 'function') {
        const isRouter = typeof fn.handle === 'function' && typeof fn.use === 'function';
        if (!isRouter) {
          arguments[i] = wrapMiddleware(fn, callerInfo);
        }
      } else if (Array.isArray(fn)) {
        arguments[i] = wrapMiddlewareArray(fn, callerInfo);
      }
    }

    return originalUse.apply(this, arguments);
  };

  express.Router.use.__isPatched = true;

  // Patch Router.param
  const originalParam = express.Router.param;
  if (originalParam && !originalParam.__isPatched) {
    express.Router.param = function(name, fn) {
      if (typeof fn === 'function') {
        const callerInfo = getCallerInfo();
        const wrappedParam = function(req, res, next, val) {
          return runWrappedParam(fn, callerInfo, this, arguments, req, res, next);
        };
        Object.defineProperty(wrappedParam, 'name', { value: fn.name || 'anonymous_param' });
        wrappedParam.__isWrapped = true;
        return originalParam.call(this, name, wrappedParam);
      }
      return originalParam.apply(this, arguments);
    };
    express.Router.param.__isPatched = true;
  }
}

/**
 * Patch Route.prototype methods to intercept and wrap verb handlers.
 */
function patchRoute() {
  if (!express.Route) return;

  const methodsToPatch = Object.getOwnPropertyNames(express.Route.prototype).filter(prop => {
    return typeof express.Route.prototype[prop] === 'function' && prop !== 'constructor';
  });

  methodsToPatch.forEach(method => {
    const originalMethod = express.Route.prototype[method];
    if (originalMethod.__isPatched) return;

    express.Route.prototype[method] = function(...args) {
      const callerInfo = getCallerInfo();

      for (let i = 0; i < arguments.length; i++) {
        const fn = arguments[i];
        if (typeof fn === 'function') {
          arguments[i] = wrapMiddleware(fn, callerInfo);
        } else if (Array.isArray(fn)) {
          arguments[i] = wrapMiddlewareArray(fn, callerInfo);
        }
      }

      return originalMethod.apply(this, arguments);
    };

    express.Route.prototype[method].__isPatched = true;
  });
}

/**
 * Patch ServerResponse to clear timer when write/writeHead is called (streaming/SSE safety).
 */
function patchResponse() {
  const originalWrite = http.ServerResponse.prototype.write;
  if (originalWrite && !originalWrite.__isPatched) {
    http.ServerResponse.prototype.write = function(...args) {
      if (this.req) {
        clearRequestTimer(this.req);
      }
      return originalWrite.apply(this, args);
    };
    http.ServerResponse.prototype.write.__isPatched = true;
  }

  const originalWriteHead = http.ServerResponse.prototype.writeHead;
  if (originalWriteHead && !originalWriteHead.__isPatched) {
    http.ServerResponse.prototype.writeHead = function(...args) {
      if (this.req) {
        clearRequestTimer(this.req);
      }
      return originalWriteHead.apply(this, args);
    };
    http.ServerResponse.prototype.writeHead.__isPatched = true;
  }
}

/**
 * Initialize the leak detector globally.
 * @param {Object} options Configuration options
 * @param {number} options.timeout Threshold in ms (default 5000)
 * @param {Object} options.logger Custom logger object (default console)
 * @param {Function} options.onLeak Custom leak handler function (receives (leakInfo, req, res))
 * @param {Array<string|RegExp>} options.excludePaths URL paths to ignore
 */
function initLeakDetector(options = {}) {
  if (isInitialized) return;
  isInitialized = true;

  Object.assign(globalOptions, options);

  patchRouter();
  patchRoute();
  patchResponse();
}

module.exports = {
  initLeakDetector
};
