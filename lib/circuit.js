'use strict';

const EventEmitter = require('events');
const Status = require('./status');
const HystrixStats = require('./hystrix-stats');
const Semaphore = require('./semaphore');

const STATE = Symbol('state');
const OPEN = Symbol('open');
const CLOSED = Symbol('closed');
const HALF_OPEN = Symbol('half-open');
const PENDING_CLOSE = Symbol('pending-close');
const SHUTDOWN = Symbol('shutdown');
const FALLBACK_FUNCTION = Symbol('fallback');
const STATUS = Symbol('status');
const NAME = Symbol('name');
const GROUP = Symbol('group');
const HYSTRIX_STATS = Symbol('hystrix-stats');
const CACHE = new WeakMap();
const ENABLED = Symbol('Enabled');
const WARMING_UP = Symbol('warming-up');
const VOLUME_THRESHOLD = Symbol('volume-threshold');
const deprecation = `options.maxFailures is deprecated. \
Please use options.errorThresholdPercentage`;

/**
 * Constructs a {@link CircuitBreaker}.
 *
 * @class CircuitBreaker
 * @extends EventEmitter
 * @param action {Function} The action to fire for this {@link CircuitBreaker}
 * @param options {Object} Options for the {@link CircuitBreaker}.
 * There are **no default options** when you use the constructor directly. You
 * must supply values for each of these.
 * @param options.timeout {Number} The time in milliseconds that action should
 * be allowed to execute before timing out. Timeout can be disabled by setting
 * this to `false`.
 * @param options.maxFailures {Number} The number of times the circuit can fail
 * before opening.
 * (deprecated - see {CircuitBreaker#options.errorThresholdPercentage})
 * @param options.resetTimeout {Number} The time in milliseconds to wait before
 * setting the breaker to `halfOpen` state, and trying the action again.
 * @param options.rollingCountTimeout {Number} Sets the duration of the
 * statistical rolling window, in milliseconds. This is how long Opossum keeps
 * metrics for the circuit breaker to use and for publishing. Default: 10000
 * @param options.rollingCountBuckets {Number} sets the number of buckets the
 * rolling statistical window is divided into. So, if
 * options.rollingCountTimeout is 10000, and options.rollingCountBuckets is 10,
 * then the statistical window will be 1000 1 second snapshots in the
 * statistical window. Default: 10
 * @param options.name {String} the circuit name to use when reporting stats
 * @param options.rollingPercentilesEnabled {Boolean} This property indicates
 * whether execution latencies should be tracked and calculated as percentiles.
 * If they are disabled, all summary statistics (mean, percentiles) are
 * returned as -1.
 * @param options.capacity {Number} the number of concurrent requests allowed.
 * If the number currently executing function calls is equal to
 * options.capacity, further calls to `fire()` are rejected until at least one
 * of the current requests completes.
 * @param options.errorThresholdPercentage {Number} the error percentage at
 * which to open the circuit and start short-circuiting requests to fallback.
 * @param options.enabled {boolean} whether this circuit is enabled upon
 * construction. Default: true
 * @param options.allowWarmUp {boolean} determines whether to allow failures
 * without opening the circuit during a brief warmup period (this is the
 * `rollingCountDuration` property). Default: false
 * allow before enabling the circuit. This can help in situations where no matter
 * what your `errorThresholdPercentage` is, if the first execution times out or
 * fails, the circuit immediately opens. Default: 0
 * @param options.volumeThreshold {Number} the minimum number of requests within
 * the rolling statistical window that must exist before the circuit breaker
 * can open. This is similar to `options.allowWarmUp` in that no matter how many
 * failures there are, if the number of requests within the statistical window
 * does not exceed this threshold, the circuit will remain closed. Default: 0
 */
class CircuitBreaker extends EventEmitter {
  constructor (action, options) {
    super();
    this.options = options;
    this.options.rollingCountTimeout = options.rollingCountTimeout || 10000;
    this.options.rollingCountBuckets = options.rollingCountBuckets || 10;
    this.options.rollingPercentilesEnabled =
      options.rollingPercentilesEnabled !== false;
    this.options.capacity = Number.isInteger(options.capacity) ? options.capacity : Number.MAX_SAFE_INTEGER;

    this.semaphore = new Semaphore(this.options.capacity);

    this[VOLUME_THRESHOLD] = Number.isInteger(options.volumeThreshold) ? options.volumeThreshold : 0;
    this[WARMING_UP] = options.allowWarmUp === true;
    this[STATUS] = new Status(this.options);
    this[STATE] = CLOSED;
    this[FALLBACK_FUNCTION] = null;
    this[PENDING_CLOSE] = false;
    this[NAME] = options.name || action.name || nextName();
    this[GROUP] = options.group || this[NAME];
    this[ENABLED] = options.enabled !== false;

    if (this[WARMING_UP]) {
      const timer = setTimeout(_ => (this[WARMING_UP] = false),
        this.options.rollingCountTimeout);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }

    if (typeof action !== 'function') {
      this.action = _ => Promise.resolve(action);
    } else this.action = action;

    if (options.maxFailures) console.error(deprecation);

    const increment = property =>
      (result, runTime) => this[STATUS].increment(property, runTime);

    this.on('success', increment('successes'));
    this.on('failure', increment('failures'));
    this.on('fallback', increment('fallbacks'));
    this.on('timeout', increment('timeouts'));
    this.on('fire', increment('fires'));
    this.on('reject', increment('rejects'));
    this.on('cacheHit', increment('cacheHits'));
    this.on('cacheMiss', increment('cacheMisses'));
    this.on('open', _ => this[STATUS].open());
    this.on('close', _ => this[STATUS].close());
    this.on('semaphore-locked', increment('semaphoreRejections'));

    /**
     * Emitted after `options.resetTimeout` has elapsed, allowing for
     * a single attempt to call the service again. If that attempt is
     * successful, the circuit will be closed. Otherwise it remains open.
     * @event CircuitBreaker#halfOpen
     */
    function _startTimer (circuit) {
      return _ => {
        const timer = setTimeout(() => {
          circuit[STATE] = HALF_OPEN;
          circuit[PENDING_CLOSE] = true;
          circuit.emit('halfOpen', circuit.options.resetTimeout);
        }, circuit.options.resetTimeout);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      };
    }

    this.on('open', _startTimer(this));
    this.on('success', _ => this.close());
    if (this.options.cache) {
      CACHE.set(this, undefined);
    }

    // Register with the hystrix stats listener
    this[HYSTRIX_STATS] = new HystrixStats(this);
  }

  /**
   * Closes the breaker, allowing the action to execute again
   * @fires CircuitBreaker#close
   */
  close () {
    this[PENDING_CLOSE] = false;
    if (this[STATE] !== CLOSED) {
      this[STATE] = CLOSED;
      /**
       * Emitted when the breaker is reset allowing the action to execute again
       * @event CircuitBreaker#close
       */
      this.emit('close');
    }
  }

  /**
   * Opens the breaker. Each time the breaker is fired while the circuit is
   * opened, a failed Promise is returned, or if any fallback function
   * has been provided, it is invoked.
   * @fires CircuitBreaker#open
   */
  open () {
    this[PENDING_CLOSE] = false;
    if (this[STATE] !== OPEN) {
      this[STATE] = OPEN;
      /**
       * Emitted when the breaker opens because the action has
       * failed more than `options.maxFailures` number of times.
       * @event CircuitBreaker#open
       */
      this.emit('open');
    }
  }

  /**
   * Shuts down this circuit breaker. All subsequent calls to the
   * circuit will fail, returning a rejected promise.
   */
  shutdown () {
    this.disable();
    this.removeAllListeners();
    this.status.shutdown();
    this.hystrixStats.shutdown();
    this[STATE] = SHUTDOWN;
  }

  /**
   * Determines if the circuit has been shutdown.
   */
  get isShutdown () {
    return this[STATE] === SHUTDOWN;
  }

  /**
   * Gets the name of this circuit
   */
  get name () {
    return this[NAME];
  }

  get group () {
    return this[GROUP];
  }

  get pendingClose () {
    return this[PENDING_CLOSE];
  }

  /**
   * True if the circuit is currently closed. False otherwise.
   */
  get closed () {
    return this[STATE] === CLOSED;
  }

  /**
   * True if the circuit is currently opened. False otherwise.
   */
  get opened () {
    return this[STATE] === OPEN;
  }

  /**
   * True if the circuit is currently half opened. False otherwise.
   */
  get halfOpen () {
    return this[STATE] === HALF_OPEN;
  }

  /**
   * The current {@link Status} of this {@link CircuitBreaker}
   */
  get status () {
    return this[STATUS];
  }

  /**
   * A convenience function that returns the current stats for the circuit.
   * @see Status#stats
   */
  get stats () {
    return this[STATUS].stats;
  }

  /**
   * A convenience function that returns the hystrixStats.
   */
  get hystrixStats () {
    return this[HYSTRIX_STATS];
  }

  get enabled () {
    return this[ENABLED];
  }

  get warmUp () {
    return this[WARMING_UP];
  }

  get volumeThreshold () {
    return this[VOLUME_THRESHOLD];
  }

  /**
   * Provide a fallback function for this {@link CircuitBreaker}. This
   * function will be executed when the circuit is `fire`d and fails.
   * It will always be preceded by a `failure` event, and `breaker.fire` returns
   * a rejected Promise.
   * @param func {Function | CircuitBreaker} the fallback function to execute
   * when the breaker has opened or when a timeout or error occurs.
   * @return {@link CircuitBreaker} this
   */
  fallback (func) {
    let fb = func;
    if (func instanceof CircuitBreaker) {
      fb = function () {
        return func.fire.apply(func, arguments);
      };
    }
    this[FALLBACK_FUNCTION] = fb;
    return this;
  }

  /**
   * Execute the action for this circuit. If the action fails or times out, the
   * returned promise will be rejected. If the action succeeds, the promise will
   * resolve with the resolved value from action. If a fallback function was
   * provided, it will be invoked in the event of any failure or timeout.
   *
   * @return a Promise which resolves on success and is rejected
   * on failure of the action.
   *
   * @fires CircuitBreaker#failure
   * @fires CircuitBreaker#fallback
   * @fires CircuitBreaker#fire
   * @fires CircuitBreaker#reject
   * @fires CircuitBreaker#success
   * @fires CircuitBreaker#timeout
   * @fires CircuitBreaker#semaphore-locked
   */
  fire () {
    if (this.isShutdown) {
      const err = new Error('The circuit has been shutdown.');
      err.code = 'ESHUTDOWN';
      return Promise.reject(err);
    }
    const args = Array.prototype.slice.call(arguments);

    /**
     * Emitted when the circuit breaker action is executed
     * @event CircuitBreaker#fire
     */
    this.emit('fire', args);

    if (CACHE.get(this) !== undefined) {
      /**
       * Emitted when the circuit breaker is using the cache
       * and finds a value.
       * @event CircuitBreaker#cacheHit
       */
      this.emit('cacheHit');
      return CACHE.get(this);
    } else if (this.options.cache) {
      /**
       * Emitted when the circuit breaker does not find a value in
       * the cache, but the cache option is enabled.
       * @event CircuitBreaker#cacheMiss
       */
      this.emit('cacheMiss');
    }

    /**
     * https://github.com/nodeshift/opossum/issues/136
     */
    if (!this[ENABLED]) {
      const result = this.action.apply(this.action, args);
      return (typeof result.then === 'function')
        ? result
        : Promise.resolve(result);
    }

    if (!this.closed && !this.pendingClose) {
      /**
       * Emitted when the circuit breaker is open and failing fast
       * @event CircuitBreaker#reject
       */
      const error = new Error('Breaker is open');
      error.code = 'EOPENBREAKER';

      this.emit('reject', error);

      return fallback(this, error, args) ||
        Promise.reject(error);
    }
    this[PENDING_CLOSE] = false;

    let timeout;
    let timeoutError = false;
    return new Promise((resolve, reject) => {
      const latencyStartTime = Date.now();
      if (this.semaphore.test()) {
        if (this.options.timeout) {
          timeout = setTimeout(
            () => {
              timeoutError = true;
              const error =
                new Error(`Timed out after ${this.options.timeout}ms`);
              error.code = 'ETIMEDOUT';
              /**
               * Emitted when the circuit breaker action takes longer than
               * `options.timeout`
               * @event CircuitBreaker#timeout
               */
              const latency = Date.now() - latencyStartTime;
              this.semaphore.release();
              this.emit('timeout', error, latency);
              resolve(handleError(
                error, this, timeout, args, latency, resolve, reject));
            }, this.options.timeout);
        }

        try {
          const result = this.action.apply(this.action, args);
          const promise = (typeof result.then === 'function')
            ? result
            : Promise.resolve(result);

          promise.then(result => {
            if (!timeoutError) {
              clearTimeout(timeout);
              /**
               * Emitted when the circuit breaker action succeeds
               * @event CircuitBreaker#success
               */
              this.emit('success', result, (Date.now() - latencyStartTime));
              this.semaphore.release();
              resolve(result);
              if (this.options.cache) {
                CACHE.set(this, promise);
              }
            }
          })
            .catch(error => {
              if (!timeoutError) {
                this.semaphore.release();
                const latencyEndTime = Date.now() - latencyStartTime;
                handleError(
                  error, this, timeout, args, latencyEndTime, resolve, reject);
              }
            });
        } catch (error) {
          this.semaphore.release();
          const latency = Date.now() - latencyStartTime;
          handleError(error, this, timeout, args, latency, resolve, reject);
        }
      } else {
        const latency = Date.now() - latencyStartTime;
        const err = new Error('Semaphore locked');
        err.code = 'ESEMLOCKED';
        /**
         * Emitted when the rate limit has been reached and there
         * are no more locks to be obtained.
         * @event CircuitBreaker#semaphore-locked
         */
        this.emit('semaphore-locked', err, latency);
        handleError(err, this, timeout, args, latency, resolve, reject);
      }
    });
  }

  /**
   * Clears the cache of this {@link CircuitBreaker}
   */
  clearCache () {
    CACHE.set(this, undefined);
  }

  /**
   * Provide a health check function to be called periodically. The function
   * should return a Promise. If the promise is rejected the circuit will open.
   * This is in addition to the existing circuit behavior as defined by
   * `options.errorThresholdPercentage` in the constructor. For example, if the
   * health check function provided here always returns a resolved promise, the
   * circuit can still trip and open if there are failures exceeding the
   * configured threshold. The health check function is executed within the
   * circuit breaker's execution context, so `this` within the function is the
   * circuit breaker itself.
   *
   * @param func {Function} a health check function which returns a promise.
   * @param [interval] {Number} the amount of time between calls to the health
   * check function. Default: 5000 (5 seconds)
   *
   * @returns {Promise}
   *
   * @fires CircuitBreaker#health-check-failed
   * @throws TypeError if `interval` is supplied but not a number
   */
  healthCheck (func, interval) {
    interval = interval || 5000;
    if (typeof func !== 'function') {
      throw new TypeError('Health check function must be a function');
    }
    if (isNaN(interval)) {
      throw new TypeError('Health check interval must be a number');
    }

    const check = _ => {
      func.apply(this).catch(e => {
        /**
         * Emitted with the user-supplied health check function
         * returns a rejected promise.
         * @event CircuitBreaker#health-check-failed
         */
        this.emit('health-check-failed', e);
        this.open();
      });
    };

    const timer = setInterval(check, interval);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    check();
  }

  /**
   * Enables this circuit. If the circuit is the  disabled
   * state, it will be re-enabled. If not, this is essentially
   * a noop.
   */
  enable () {
    this[ENABLED] = true;
  }

  /**
   * Disables this circuit, causing all calls to the circuit's function
   * to be executed without circuit or fallback protection.
   */
  disable () {
    this[ENABLED] = false;
  }
}

function handleError (error, circuit, timeout, args, latency, resolve, reject) {
  clearTimeout(timeout);
  fail(circuit, error, args, latency);
  const fb = fallback(circuit, error, args);
  if (fb) resolve(fb);
  else reject(error);
}

function fallback (circuit, err, args) {
  if (circuit[FALLBACK_FUNCTION]) {
    const result =
      circuit[FALLBACK_FUNCTION].apply(circuit[FALLBACK_FUNCTION], [...args, err]);
    /**
     * Emitted when the circuit breaker executes a fallback function
     * @event CircuitBreaker#fallback
     */
    circuit.emit('fallback', result, err);
    if (result instanceof Promise) return result;
    return Promise.resolve(result);
  }
}

function fail (circuit, err, args, latency) {
  /**
   * Emitted when the circuit breaker action fails
   * @event CircuitBreaker#failure
   */
  circuit.emit('failure', err, latency);
  if (circuit.warmUp) return;

  // check stats to see if the circuit should be opened
  const stats = circuit.stats;
  if (stats.fires < circuit.volumeThreshold) return;
  const errorRate = stats.failures / stats.fires * 100;
  if (errorRate > circuit.options.errorThresholdPercentage ||
    stats.failures >= circuit.options.maxFailures ||
    circuit.halfOpen) {
    circuit.open();
  }
}

// http://stackoverflow.com/a/2117523
const nextName = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });

module.exports = exports = CircuitBreaker;
