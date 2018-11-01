'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var child_process = require('child_process');
var path = _interopDefault(require('path'));
var fs = _interopDefault(require('fs'));
var net = _interopDefault(require('net'));
var http = _interopDefault(require('http'));

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

function clearConnection(client) {
  if (client) {
    client.removeAllListeners();
    client.end();
    client.destroy();
    client.unref();
  }
}

function debug(...args) {
  return process.env.DEBUG ? console.log('@serverless-chrome/lambda:', ...args) : undefined;
}

let delay = (() => {
  var _ref = _asyncToGenerator(function* (time) {
    return new Promise(function (resolve) {
      return setTimeout(resolve, time);
    });
  });

  return function delay(_x) {
    return _ref.apply(this, arguments);
  };
})();

function makeTempDir() {
  return child_process.execSync('mktemp -d -t chrome.XXXXXXX').toString().trim();
}

/**
 * Checks if a process currently exists by process id.
 * @param pid number process id to check if exists
 * @returns boolean true if process exists, false if otherwise
 */
function processExists(pid) {
  let exists = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    exists = false;
  }
  return exists;
}

const LOGGING_FLAGS = process.env.DEBUG ? ['--enable-logging', '--log-level=0', '--v=99'] : [];

var DEFAULT_CHROME_FLAGS = [...LOGGING_FLAGS, '--disable-dev-shm-usage', // disable /dev/shm tmpfs usage on Lambda

// @TODO: review if these are still relevant:
'--disable-gpu', '--single-process', // Currently wont work without this :-(

// https://groups.google.com/a/chromium.org/d/msg/headless-dev/qqbZVZ2IwEw/Y95wJUh2AAAJ
'--no-zygote', // helps avoid zombies

'--no-sandbox'];

function _asyncToGenerator$1(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const CHROME_PATH = path.resolve(__dirname, './headless-chromium');

class Launcher {
  constructor(options = {}) {
    const {
      chromePath = CHROME_PATH,
      chromeFlags = [],
      startingUrl = 'about:blank',
      port = 0
    } = options;

    this.tmpDirandPidFileReady = false;
    this.pollInterval = 500;
    this.pidFile = '';
    this.startingUrl = 'about:blank';
    this.outFile = null;
    this.errFile = null;
    this.chromePath = CHROME_PATH;
    this.chromeFlags = [];
    this.requestedPort = 0;
    this.userDataDir = '';
    this.port = 9222;
    this.pid = null;
    this.chrome = undefined;

    this.options = options;
    this.startingUrl = startingUrl;
    this.chromeFlags = chromeFlags;
    this.chromePath = chromePath;
    this.requestedPort = port;
  }

  get flags() {
    return [...DEFAULT_CHROME_FLAGS, `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.userDataDir}`, '--disable-setuid-sandbox', ...this.chromeFlags, this.startingUrl];
  }

  prepare() {
    this.userDataDir = this.options.userDataDir || makeTempDir();
    this.outFile = fs.openSync(`${this.userDataDir}/chrome-out.log`, 'a');
    this.errFile = fs.openSync(`${this.userDataDir}/chrome-err.log`, 'a');
    this.pidFile = '/tmp/chrome.pid';
    this.tmpDirandPidFileReady = true;
  }

  // resolves if ready, rejects otherwise
  isReady() {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.port);

      client.once('error', error => {
        clearConnection(client);
        reject(error);
      });

      client.once('connect', () => {
        clearConnection(client);
        resolve();
      });
    });
  }

  // resolves when debugger is ready, rejects after 10 polls
  waitUntilReady() {
    const launcher = this;

    return new Promise((resolve, reject) => {
      let retries = 0;
      (function poll() {
        debug('Waiting for Chrome', retries);

        launcher.isReady().then(() => {
          debug('Started Chrome');
          resolve();
        }).catch(error => {
          retries += 1;

          if (retries > 10) {
            return reject(error);
          }

          return delay(launcher.pollInterval).then(poll);
        });
      })();
    });
  }

  // resolves when chrome is killed, rejects  after 10 polls
  waitUntilKilled() {
    return Promise.all([new Promise((resolve, reject) => {
      let retries = 0;
      const server = http.createServer();

      server.once('listening', () => {
        debug('Confirmed Chrome killed');
        server.close(resolve);
      });

      server.on('error', () => {
        retries += 1;

        debug('Waiting for Chrome to terminate..', retries);

        if (retries > 10) {
          reject(new Error('Chrome is still running after 10 retries'));
        }

        setTimeout(() => {
          server.listen(this.port);
        }, this.pollInterval);
      });

      server.listen(this.port);
    }), new Promise(resolve => {
      this.chrome.on('close', resolve);
    })]);
  }

  spawn() {
    var _this = this;

    return _asyncToGenerator$1(function* () {
      const spawnPromise = new Promise((() => {
        var _ref = _asyncToGenerator$1(function* (resolve) {
          if (_this.chrome) {
            debug(`Chrome already running with pid ${_this.chrome.pid}.`);
            return resolve(_this.chrome.pid);
          }

          const chrome = child_process.spawn(_this.chromePath, _this.flags, {
            detached: true,
            stdio: ['ignore', _this.outFile, _this.errFile]
          });

          _this.chrome = chrome;

          // unref the chrome instance, otherwise the lambda process won't end correctly
          if (chrome.chrome) {
            chrome.chrome.removeAllListeners();
            chrome.chrome.unref();
          }

          fs.writeFileSync(_this.pidFile, chrome.pid.toString());

          debug('Launcher', `Chrome running with pid ${chrome.pid} on port ${_this.port}.`);

          return resolve(chrome.pid);
        });

        return function (_x) {
          return _ref.apply(this, arguments);
        };
      })());

      const pid = yield spawnPromise;
      yield _this.waitUntilReady();
      return pid;
    })();
  }

  launch() {
    var _this2 = this;

    return _asyncToGenerator$1(function* () {
      if (_this2.requestedPort !== 0) {
        _this2.port = _this2.requestedPort;

        // If an explict port is passed first look for an open connection...
        try {
          return yield _this2.isReady();
        } catch (err) {
          debug('ChromeLauncher', `No debugging port found on port ${_this2.port}, launching a new Chrome.`);
        }
      }

      if (!_this2.tmpDirandPidFileReady) {
        _this2.prepare();
      }

      _this2.pid = yield _this2.spawn();
      return Promise.resolve();
    })();
  }

  kill() {
    var _this3 = this;

    return new Promise((() => {
      var _ref2 = _asyncToGenerator$1(function* (resolve, reject) {
        if (_this3.chrome) {
          debug('Trying to terminate Chrome instance');

          try {
            process.kill(-_this3.chrome.pid);

            debug('Waiting for Chrome to terminate..');
            yield _this3.waitUntilKilled();
            debug('Chrome successfully terminated.');

            _this3.destroyTemp();

            delete _this3.chrome;
            return resolve();
          } catch (error) {
            debug('Chrome could not be killed', error);
            return reject(error);
          }
        } else {
          // fail silently as we did not start chrome
          return resolve();
        }
      });

      return function (_x2, _x3) {
        return _ref2.apply(this, arguments);
      };
    })());
  }

  destroyTemp() {
    return new Promise(resolve => {
      // Only clean up the tmp dir if we created it.
      if (this.userDataDir === undefined || this.options.userDataDir !== undefined) {
        return resolve();
      }

      if (this.outFile) {
        fs.closeSync(this.outFile);
        delete this.outFile;
      }

      if (this.errFile) {
        fs.closeSync(this.errFile);
        delete this.errFile;
      }

      return child_process.execSync(`rm -Rf ${this.userDataDir}`, resolve);
    });
  }
}

function _asyncToGenerator$2(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const DEVTOOLS_PORT = 9222;
const DEVTOOLS_HOST = 'http://127.0.0.1';

// Prepend NSS related libraries and binaries to the library path and path respectively on lambda.
/* if (process.env.AWS_EXECUTION_ENV) {
  const nssSubPath = fs.readFileSync(path.join(__dirname, 'nss', 'latest'), 'utf8').trim();
  const nssPath = path.join(__dirname, 'nss', subnssSubPathPath);

  process.env.LD_LIBRARY_PATH = path.join(nssPath, 'lib') +  ':' + process.env.LD_LIBRARY_PATH;
  process.env.PATH = path.join(nssPath, 'bin') + ':' + process.env.PATH;
} */

// persist the instance across invocations
// when the *lambda* container is reused.
let chromeInstance;

var index = (() => {
  var _ref = _asyncToGenerator$2(function* ({
    flags = [],
    chromePath,
    port = DEVTOOLS_PORT,
    forceLambdaLauncher = false
  } = {}) {
    const chromeFlags = [...DEFAULT_CHROME_FLAGS, ...flags];

    if (!chromeInstance || !processExists(chromeInstance.pid)) {
      if (process.env.AWS_EXECUTION_ENV || forceLambdaLauncher) {
        chromeInstance = new Launcher({
          chromePath,
          chromeFlags,
          port
        });
      } else {
        // This let's us use chrome-launcher in local development,
        // but omit it from the lambda function's zip artefact
        try {
          // eslint-disable-next-line
          const { Launcher: LocalChromeLauncher } = require('chrome-launcher');
          chromeInstance = new LocalChromeLauncher({
            chromePath,
            chromeFlags: flags,
            port
          });
        } catch (error) {
          throw new Error('@serverless-chrome/lambda: Unable to find "chrome-launcher". ' + "Make sure it's installed if you wish to develop locally.");
        }
      }
    }

    debug('Spawning headless shell');

    const launchStartTime = Date.now();

    try {
      yield chromeInstance.launch();
    } catch (error) {
      debug('Error trying to spawn chrome:', error);

      if (process.env.DEBUG) {
        debug('stdout log:', fs.readFileSync(`${chromeInstance.userDataDir}/chrome-out.log`, 'utf8'));
        debug('stderr log:', fs.readFileSync(`${chromeInstance.userDataDir}/chrome-err.log`, 'utf8'));
      }

      throw new Error('Unable to start Chrome. If you have the DEBUG env variable set,' + 'there will be more in the logs.');
    }

    const launchTime = Date.now() - launchStartTime;

    debug(`It took ${launchTime}ms to spawn chrome.`);

    // unref the chrome instance, otherwise the lambda process won't end correctly
    /* @TODO: make this an option?
      There's an option to change callbackWaitsForEmptyEventLoop in the Lambda context
      http://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
      Which means you could log chrome output to cloudwatch directly
      without unreffing chrome.
    */
    if (chromeInstance.chrome) {
      chromeInstance.chrome.removeAllListeners();
      chromeInstance.chrome.unref();
    }

    return {
      pid: chromeInstance.pid,
      port: chromeInstance.port,
      url: `${DEVTOOLS_HOST}:${chromeInstance.port}`,
      log: `${chromeInstance.userDataDir}/chrome-out.log`,
      errorLog: `${chromeInstance.userDataDir}/chrome-err.log`,
      pidFile: `${chromeInstance.userDataDir}/chrome.pid`,
      metaData: {
        launchTime,
        didLaunch: !!chromeInstance.pid
      },
      kill() {
        return _asyncToGenerator$2(function* () {
          // Defer killing chrome process to the end of the execution stack
          // so that the node process doesn't end before chrome exists,
          // avoiding chrome becoming orphaned.
          setTimeout(_asyncToGenerator$2(function* () {
            chromeInstance.kill();
            chromeInstance = undefined;
          }), 0);
        })();
      }
    };
  });

  function launch() {
    return _ref.apply(this, arguments);
  }

  return launch;
})();

module.exports = index;
