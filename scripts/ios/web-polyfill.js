/**
 * Browser-side polyfill bundle for the dsh web UI on older Safari.
 *
 * Injected into @deepseek-ai/dsh-web-frontend/dist/index.html at build time by
 * scripts/ios/inject-web-polyfill.py, as a classic script before the module
 * entry.
 *
 * Covers what the client bundles reach for but iOS 16/17 Safari lacks:
 *
 *   AbortSignal.any           Safari 17.4
 *   AbortSignal.timeout       Safari 16.4
 *   Promise.withResolvers     Safari 17.4
 *   Object.groupBy            Safari 17.4
 *   Map.groupBy               Safari 17.4
 *   Array.fromAsync           Safari 18.0
 *   Iterator helpers + global Safari 18.4
 *
 * The Iterator section is adapted from xlpoistop-prog/dsh-ios
 * (preload/iterator-polyfill.js, MIT) — the feature-detection idiom
 * `typeof Iterator.prototype.join !== 'function'` throws a ReferenceError on
 * engines where the global does not exist at all, so the global has to be
 * published, not just the methods.
 *
 * Every block is guarded: a newer engine keeps its native implementation and
 * this file becomes a no-op.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- Iterator
  var iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

  function define(target, name, value) {
    if (name in target) return;
    Object.defineProperty(target, name, {
      value: value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  function iteratorFrom(nextThunk) {
    var iterator = { next: nextThunk };
    Object.setPrototypeOf(iterator, iteratorPrototype);
    return iterator;
  }

  function toIterator(value) {
    if (value !== null && value !== undefined && typeof value.next === 'function') return value;
    var method = value[Symbol.iterator];
    return method.call(value);
  }

  define(iteratorPrototype, 'map', function map(mapper) {
    var source = this;
    return iteratorFrom(function () {
      var step = source.next();
      if (step.done) return step;
      return { value: mapper(step.value), done: false };
    });
  });

  define(iteratorPrototype, 'filter', function filter(predicate) {
    var source = this;
    return iteratorFrom(function () {
      for (;;) {
        var step = source.next();
        if (step.done) return step;
        if (predicate(step.value)) return step;
      }
    });
  });

  define(iteratorPrototype, 'take', function take(limit) {
    var source = this;
    var remaining = Math.max(0, Number(limit) || 0);
    return iteratorFrom(function () {
      if (remaining <= 0) return { value: undefined, done: true };
      remaining -= 1;
      return source.next();
    });
  });

  define(iteratorPrototype, 'drop', function drop(limit) {
    var source = this;
    var remaining = Math.max(0, Number(limit) || 0);
    var dropped = false;
    return iteratorFrom(function () {
      if (!dropped) {
        while (remaining > 0) {
          remaining -= 1;
          if (source.next().done) { dropped = true; return { value: undefined, done: true }; }
        }
        dropped = true;
      }
      return source.next();
    });
  });

  define(iteratorPrototype, 'flatMap', function flatMap(mapper) {
    var source = this;
    var inner = null;
    return iteratorFrom(function () {
      for (;;) {
        if (inner === null) {
          var step = source.next();
          if (step.done) return step;
          inner = toIterator(mapper(step.value));
        }
        var next = inner.next();
        if (next.done) { inner = null; continue; }
        return next;
      }
    });
  });

  define(iteratorPrototype, 'toArray', function toArray() { return Array.from(this); });

  define(iteratorPrototype, 'forEach', function forEach(callback) {
    for (;;) {
      var step = this.next();
      if (step.done) return undefined;
      callback(step.value);
    }
  });

  define(iteratorPrototype, 'reduce', function reduce(reducer, initial) {
    var accumulated = initial;
    var hasInitial = arguments.length > 1;
    for (;;) {
      var step = this.next();
      if (step.done) {
        if (!hasInitial) throw new TypeError('Reduce of empty iterator with no initial value');
        return accumulated;
      }
      if (!hasInitial) { accumulated = step.value; hasInitial = true; continue; }
      accumulated = reducer(accumulated, step.value);
    }
  });

  define(iteratorPrototype, 'some', function some(predicate) {
    for (;;) {
      var step = this.next();
      if (step.done) return false;
      if (predicate(step.value)) return true;
    }
  });

  define(iteratorPrototype, 'every', function every(predicate) {
    for (;;) {
      var step = this.next();
      if (step.done) return true;
      if (!predicate(step.value)) return false;
    }
  });

  define(iteratorPrototype, 'find', function find(predicate) {
    for (;;) {
      var step = this.next();
      if (step.done) return undefined;
      if (predicate(step.value)) return step.value;
    }
  });

  define(iteratorPrototype, 'join', function join(separator) {
    return Array.from(this).join(separator);
  });

  if (!(Symbol.iterator in iteratorPrototype)) {
    Object.defineProperty(iteratorPrototype, Symbol.iterator, {
      value: function () { return this; },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  if (typeof globalThis.Iterator === 'undefined') {
    var Iterator = function Iterator() {
      throw new TypeError('Abstract class Iterator not directly constructable');
    };
    Iterator.prototype = iteratorPrototype;
    define(Iterator, 'from', function from(value) {
      var iterator = toIterator(value);
      return Object.setPrototypeOf(
        { next: function next() { return iterator.next(); } },
        iteratorPrototype
      );
    });
    Object.defineProperty(globalThis, 'Iterator', {
      value: Iterator, writable: true, enumerable: false, configurable: true,
    });
  } else if (typeof globalThis.Iterator.prototype !== 'object') {
    globalThis.Iterator.prototype = iteratorPrototype;
  }

  // ------------------------------------------------------------ AbortSignal
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    AbortSignal.any = function any(signals) {
      var controller = new AbortController();
      var cleanups = [];
      var done = false;

      function cleanup() {
        while (cleanups.length) {
          try { cleanups.pop()(); } catch (e) {}
        }
      }
      function abort(reason) {
        if (done) return;
        done = true;
        cleanup();
        controller.abort(reason);
      }

      var list = Array.from(signals);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].aborted) { abort(list[i].reason); break; }
      }
      if (!done) {
        for (var j = 0; j < list.length; j += 1) {
          (function (signal) {
            var onAbort = function () { abort(signal.reason); };
            signal.addEventListener('abort', onAbort, { once: true });
            cleanups.push(function () { signal.removeEventListener('abort', onAbort); });
          })(list[j]);
        }
      }
      return controller.signal;
    };
  }

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function timeout(ms) {
      var controller = new AbortController();
      setTimeout(function () {
        var reason;
        try { reason = new DOMException('The operation timed out.', 'TimeoutError'); }
        catch (e) { reason = new Error('The operation timed out.'); reason.name = 'TimeoutError'; }
        controller.abort(reason);
      }, ms);
      return controller.signal;
    };
  }

  // ------------------------------------------------------------ Promise/ES
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function withResolvers() {
      var resolve;
      var reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }

  if (typeof Object.groupBy !== 'function') {
    Object.groupBy = function groupBy(items, callback) {
      var result = Object.create(null);
      var index = 0;
      for (var item of items) {
        var key = callback(item, index);
        index += 1;
        if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = [];
        result[key].push(item);
      }
      return result;
    };
  }

  if (typeof Map.groupBy !== 'function') {
    Map.groupBy = function groupBy(items, callback) {
      var result = new Map();
      var index = 0;
      for (var item of items) {
        var key = callback(item, index);
        index += 1;
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(item);
      }
      return result;
    };
  }

  if (typeof Array.fromAsync !== 'function') {
    Array.fromAsync = function fromAsync(items, mapFn, thisArg) {
      return (async function () {
        var out = [];
        if (items === null || items === undefined) {
          throw new TypeError('Array.fromAsync: items must be iterable or array-like');
        }
        var index = 0;
        if (typeof items[Symbol.asyncIterator] === 'function' || typeof items[Symbol.iterator] === 'function') {
          for await (var value of items) {
            out.push(typeof mapFn === 'function' ? await mapFn.call(thisArg, value, index) : value);
            index += 1;
          }
          return out;
        }
        var length = Number(items.length) || 0;
        for (var i = 0; i < length; i += 1) {
          var entry = await items[i];
          out.push(typeof mapFn === 'function' ? await mapFn.call(thisArg, entry, i) : entry);
        }
        return out;
      })();
    };
  }
})();