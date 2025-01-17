import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

import keys from './keys';
import {
  CancelToken,
  request,
  RequestOptions,
  RequestMethod,
  Response
} from '@theintern/common';
import Session, { WebDriverTimeouts } from './Session';
import Element from './Element';
import statusCodes from './lib/statusCodes';
import { format, parse, resolve, Url } from 'url';
import { sleep, trimStack } from './lib/util';
import { Capabilities, LeadfootURL, LeadfootError } from './interfaces';

export default class Server {
  url: string;

  requestOptions: RequestOptions;

  /**
   * An alternative session constructor. Defaults to the standard [[Session]]
   * constructor if one is not provided.
   */
  sessionConstructor = Session;

  /**
   * Whether or not to detect and/or correct environment capabilities when
   * creating a new Server. If the value is "no-detect", capabilities will be
   * updated with already-known features and defects based on the platform, but
   * no tests will be run.
   */
  fixSessionCapabilities: boolean | 'no-detect' = true;

  // Use custom agents with keepAlive enabled to improve test efficiency,
  // particularly with remote services such as BrowserStack. See
  // https://github.com/browserstack/fast-selenium-scripts/blob/master/node/fast-selenium.js
  private _httpAgent = new HttpAgent({
    keepAlive: true,
    keepAliveMsecs: 30000
  });
  private _httpsAgent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 30000
  });

  /**
   * The Server class represents a remote HTTP server implementing the
   * WebDriver wire protocol that can be used to generate new remote control
   * sessions.
   *
   * @param url The fully qualified URL to the JsonWireProtocol endpoint on
   * the server. The default endpoint for a JsonWireProtocol HTTP server is
   * http://localhost:4444/wd/hub. You may also pass a parsed URL object
   * which will be converted to a string.
   * @param options Additional request options to be used for requests to the
   * server.
   */
  // TODO: NodeRequestOptions doesn't take a type in dojo-core alpha 20
  constructor(url: string | LeadfootURL, options?: RequestOptions) {
    if (typeof url === 'object') {
      url = <LeadfootURL>{ ...url };
      if (url.username || url.password || url.accessKey) {
        url.auth =
          encodeURIComponent(url.username || '') +
          ':' +
          encodeURIComponent(url.password || url.accessKey || '');
      }
    }

    this.url = format(<Url>url).replace(/\/*$/, '/');
    this.requestOptions = options || {};
  }

  /**
   * A function that performs an HTTP request to a JsonWireProtocol endpoint
   * and normalises response status and data.
   *
   * @param method The HTTP method to fix
   *
   * @param path The path-part of the JsonWireProtocol URL. May contain
   * placeholders in the form `/\$\d/` that will be replaced by entries in
   * the `pathParts` argument.
   *
   * @param requestData The payload for the request.
   *
   * @param pathParts Optional placeholder values to inject into the path of
   * the URL.
   */
  private _sendRequest<T>(
    method: RequestMethod,
    path: string,
    requestData: any,
    pathParts?: string[],
    token?: CancelToken
  ): Promise<T> {
    const url =
      this.url +
      path.replace(/\$(\d)/, function (_, index) {
        return encodeURIComponent(pathParts![index]);
      });

    const defaultRequestHeaders: { [key: string]: string } = {
      // At least FirefoxDriver on Selenium 2.40.0 will throw a
      // NullPointerException when retrieving session capabilities if an
      // Accept header is not provided. (It is a good idea to provide one
      // anyway)
      Accept: 'application/json,text/plain;q=0.9'
    };

    const headers = { ...defaultRequestHeaders };
    const httpAgent = this._httpAgent;
    const httpsAgent = this._httpsAgent;

    const kwArgs: RequestOptions = {
      ...this.requestOptions,
      followRedirects: false,
      handleAs: 'text',
      headers,
      method,
      httpAgent,
      httpsAgent,
      cancelToken: token
    };

    if (requestData) {
      kwArgs.data = JSON.stringify(requestData);
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      // At least ChromeDriver 2.9.248307 will not process request data
      // if the length of the data is not provided. (It is a good idea to
      // provide one anyway)
      headers['Content-Length'] = String(
        Buffer.byteLength(kwArgs.data, 'utf8')
      );
    } else {
      // At least Selenium 2.41.0 - 2.42.2 running as a grid hub will
      // throw an exception and drop the current session if a
      // Content-Length header is not provided with a DELETE or POST
      // request, regardless of whether the request actually contains any
      // request data.
      headers['Content-Length'] = '0';
    }

    const trace: any = {};
    Error.captureStackTrace(trace, this._sendRequest);

    return new Promise<Response>((resolve, reject) => {
      request(url, kwArgs)
        .then(resolve, reject)
        .finally(() => {
          const error = new Error('Cancelled');
          error.name = 'CancelError';
          reject(error);
        });
    })
      .then(function handleResponse(
        response: Response
      ): ResponseData | Promise<ResponseData> {
        // The JsonWireProtocol specification prior to June 2013 stated
        // that creating a new session should perform a 3xx redirect to
        // the session capabilities URL, instead of simply returning
        // the returning data about the session; as a result, we need
        // to follow all redirects to get consistent data
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.get('Location')
        ) {
          let redirectUrl = response.headers.get('Location')!;

          // If redirectUrl isn't an absolute URL, resolve it based
          // on the orignal URL used to create the session
          if (!/^\w+:/.test(redirectUrl)) {
            redirectUrl = resolve(url, redirectUrl);
          }

          return request(redirectUrl, {
            headers: defaultRequestHeaders,
            httpAgent,
            httpsAgent
          }).then(handleResponse);
        }

        return response.text().then(data => {
          return { response, data };
        });
      })
      .then((responseData: ResponseData) => {
        const response = responseData.response;
        const responseType = response.headers.get('Content-Type');
        let data: any;

        if (
          responseType &&
          responseType.indexOf('application/json') === 0 &&
          responseData.data
        ) {
          data = JSON.parse(responseData.data);
        }

        // Some drivers will respond to a DELETE request with 204; in
        // this case, we know the operation completed successfully, so
        // just create an expected response data structure for a
        // successful operation to avoid any special conditions
        // elsewhere in the code caused by different HTTP return values
        if (response.status === 204) {
          data = {
            status: 0,
            sessionId: null,
            value: null
          };
        } else if (response.status >= 400 || (data && data.status > 0)) {
          const error: any = new Error();

          // "The client should interpret a 404 Not Found response
          // from the server as an "Unknown command" response. All
          // other 4xx and 5xx responses from the server that do not
          // define a status field should be interpreted as "Unknown
          // error" responses." -
          // http://code.google.com/p/selenium/wiki/JsonWireProtocol#Response_Status_Codes
          if (!data) {
            data = {
              status:
                response.status === 404 || response.status === 501 ? 9 : 13,
              value: {
                message: responseData.data
              }
            };
          } else if (!data.value && 'message' in data) {
            // ios-driver 0.6.6-SNAPSHOT April 2014 incorrectly
            // implements the specification: does not return error
            // data on the `value` key, and does not return the
            // correct HTTP status for unknown commands
            data = {
              status:
                response.status === 404 ||
                response.status === 501 ||
                data.message.indexOf('cannot find command') > -1
                  ? 9
                  : 13,
              value: data
            };
          }

          // At least BrowserStack in December 2020 returns response data with
          // a value but no status
          if (!data.status) {
            data.status =
              response.status === 404 || response.status === 501 ? 9 : 13;
          }

          // At least InternetExplorerDriver 3.141.59 includes `status` and
          // `value` fields but uses HTTP status codes
          if (data.status === 404 || data.status === 501) {
            data.status = 9;
          }

          // At least Appium April 2014 responds with the HTTP status
          // Not Implemented but a Selenium status UnknownError for
          // commands that are not implemented; these errors are more
          // properly represented to end-users using the Selenium
          // status UnknownCommand, so we make the appropriate
          // coercion here
          if (response.status === 501 && data.status === 13) {
            data.status = 9;
          }

          // At least BrowserStack in May 2016 responds with HTTP 500
          // and a message value of "Invalid Command" for at least
          // some unknown commands. These errors are more properly
          // represented to end-users using the Selenium status
          // UnknownCommand, so we make the appropriate coercion here
          if (
            response.status === 500 &&
            data.value &&
            data.value.message === 'Invalid Command'
          ) {
            data.status = 9;
          }

          // At least BrowserStack in Aug 2020 responds with HTTP 422
          // and a message value of "Invalid Command" for at least
          // some unknown commands. These errors are more properly
          // represented to end-users using the Selenium status
          // UnknownCommand, so we make the appropriate coercion here
          if (
            response.status === 422 &&
            data.value?.message === 'Invalid Command'
          ) {
            data.status = 9;
          }

          // At least FirefoxDriver 2.40.0 responds with HTTP status
          // codes other than Not Implemented and a Selenium status
          // UnknownError for commands that are not implemented;
          // however, it provides a reliable indicator that the
          // operation was unsupported by the type of the exception
          // that was thrown, so also coerce this back into an
          // UnknownCommand response for end-user code
          if (
            data.status === 13 &&
            data.value &&
            data.value.class &&
            (data.value.class.indexOf('UnsupportedOperationException') > -1 ||
              data.value.class.indexOf('UnsupportedCommandException') > -1)
          ) {
            data.status = 9;
          }

          // At least InternetExplorerDriver 2.41.0 & SafariDriver
          // 2.41.0 respond with HTTP status codes other than Not
          // Implemented and a Selenium status UnknownError for
          // commands that are not implemented; like FirefoxDriver
          // they provide a reliable indicator of unsupported
          // commands
          if (
            response.status === 500 &&
            data.value &&
            data.value.message &&
            (data.value.message.indexOf('Command not found') > -1 ||
              data.value.message.indexOf('Unknown command') > -1)
          ) {
            data.status = 9;
          }

          // At least GhostDriver 1.1.0 incorrectly responds with
          // HTTP 405 instead of HTTP 501 for unimplemented commands
          if (
            response.status === 405 &&
            data.value &&
            data.value.message &&
            data.value.message.indexOf('Invalid Command Method') > -1
          ) {
            data.status = 9;
          }

          const statusCode = statusCodes[<keyof typeof statusCodes>data.status];
          if (statusCode) {
            const [name, message] = statusCode;
            if (name && message) {
              error.name = name;
              error.message = message;
            }
          }

          if (data.value && data.value.message) {
            error.message = data.value.message;
          }

          if (data.value && data.value.screen) {
            data.value.screen = Buffer.from(data.value.screen, 'base64');
          }

          error.status = data.status;
          error.detail = data.value;
          error.name = getErrorName(error);

          error.request = {
            url: url,
            method: method,
            data: requestData
          };
          error.response = response;

          const sanitizedUrl = (function () {
            const parsedUrl = parse(url);
            if (parsedUrl.auth) {
              parsedUrl.auth = '(redacted)';
            }

            return format(parsedUrl);
          })();

          error.message =
            `[${method} ${sanitizedUrl}` +
            (requestData ? ` / ${JSON.stringify(requestData)}` : '') +
            `] ${error.message}`;
          error.stack = error.message + trimStack(trace.stack);

          throw error;
        }

        return data;
      })
      .catch(function (error) {
        error.stack = error.message + trimStack(trace.stack);
        throw error;
      });
  }

  get<T>(
    path: string,
    requestData?: Record<string, any>,
    pathParts?: string[],
    token?: CancelToken
  ): Promise<T> {
    return this._sendRequest<T>('GET', path, requestData, pathParts, token);
  }

  post<T>(
    path: string,
    requestData?: Record<string, any>,
    pathParts?: string[],
    token?: CancelToken
  ): Promise<T> {
    return this._sendRequest<T>('POST', path, requestData, pathParts, token);
  }

  delete<T>(
    path: string,
    requestData?: Record<string, any>,
    pathParts?: string[],
    token?: CancelToken
  ): Promise<T> {
    return this._sendRequest<T>('DELETE', path, requestData, pathParts, token);
  }

  /**
   * Gets the status of the remote server.
   *
   * @returns An object containing arbitrary properties describing the status
   * of the remote server.
   */
  getStatus() {
    return this.get('status').then(returnValue);
  }

  /**
   * Creates a new remote control session on the remote server.
   *
   * @param desiredCapabilities A hash map of desired capabilities of the
   * remote environment. The server may return an environment that does not
   * match all the desired capabilities if one is not available.
   *
   * @param requiredCapabilities A hash map of required capabilities of the
   * remote environment. The server will not return an environment that does
   * not match all the required capabilities if one is not available.
   */
  createSession<S extends Session = Session>(
    desiredCapabilities: Capabilities,
    requiredCapabilities?: Capabilities
  ): Promise<S> {
    let fixSessionCapabilities = this.fixSessionCapabilities;
    if (desiredCapabilities.fixSessionCapabilities != null) {
      fixSessionCapabilities = desiredCapabilities.fixSessionCapabilities;

      // Don’t send `fixSessionCapabilities` to the server
      desiredCapabilities = { ...desiredCapabilities };
      desiredCapabilities.fixSessionCapabilities = undefined;
    }

    return this.post<any>('session', {
      desiredCapabilities,
      requiredCapabilities
    }).then(response => {
      let responseData: object;
      let sessionId: string;

      if (response.value.sessionId && response.value.capabilities) {
        // At least geckodriver 0.16 - 0.19 return the sessionId and
        // capabilities as value.sessionId and value.capabilities.
        responseData = response.value.capabilities;
        sessionId = response.value.sessionId;
      } else if (response.value.value && response.value.sessionId) {
        // At least geckodriver 0.15.0 returns the sessionId and
        // capabilities as value.sessionId and value.value.
        responseData = response.value.value;
        sessionId = response.value.sessionId;
      } else {
        // Selenium and chromedriver return the sessionId as a top
        // level property in the response, and the capabilities in a
        // 'value' property.
        responseData = response.value;
        sessionId = response.sessionId;
      }

      const session = new this.sessionConstructor(
        sessionId,
        this,
        responseData
      );

      // Add any desired capabilities that were originally specified but aren't
      // present in the capabilities returned by the server. This will allow
      // for feature flags to be manually set.
      const userKeys = Object.keys(desiredCapabilities).filter(
        key => !(key in session.capabilities)
      );
      for (const key of userKeys) {
        session.capabilities[key] = desiredCapabilities[key];
      }

      if (fixSessionCapabilities) {
        return this._fillCapabilities(
          <S>session,
          fixSessionCapabilities !== 'no-detect'
        )
          .catch(error =>
            // The session was started on the server, but we did
            // not resolve the promise yet. If a failure occurs during
            // capabilities filling, we should quit the session on
            // the server too since the caller will not be aware
            // that it ever got that far and will have no access to
            // the session to quit itself.
            session.quit().finally(() => {
              throw error;
            })
          )
          .then(() => <S>session);
      } else {
        return <S>session;
      }
    });
  }

  /**
   * Fill in known capabilities/defects and optionally run tests to detect
   * more
   */
  private _fillCapabilities<S extends Session>(
    session: S,
    detectCapabilities = true
  ): Promise<S> {
    Object.assign(session.capabilities, this._getKnownCapabilities(session));
    return (detectCapabilities
      ? this._detectCapabilities(session)
      : Promise.resolve(session)
    ).then(() => {
      Object.defineProperty(session.capabilities, '_filled', {
        value: true,
        configurable: true
      });
      return session;
    });
  }

  /**
   * Return capabilities and defects that don't require running tests
   */
  private _getKnownCapabilities(session: Session) {
    const capabilities = session.capabilities;
    const updates: Capabilities = {};

    // Safari 10 and 11 report their versions on a 'version' property using
    // non-contiguous version numbers. Versions < 10 use standard numbers on
    // a 'version' property, while versions >= 12 use standard numbers on a
    // browserVersion property.
    if (
      isSafari(session.capabilities) &&
      !session.capabilities.browserVersion
    ) {
      const { version } = session.capabilities;
      const versionNum = parseFloat(version!);
      if (versionNum > 12000 && versionNum < 13000) {
        session.capabilities.browserVersion = '10';
      } else if (versionNum > 13000) {
        session.capabilities.browserVersion = '11';
      }
    }

    // At least geckodriver 0.15.0 only returns platformName (not platform)
    // and browserVersion (not version) in its capabilities.
    if (capabilities.platform && !capabilities.platformName) {
      capabilities.platformName = capabilities.platform;
    }
    if (capabilities.version && !capabilities.browserVersion) {
      capabilities.browserVersion = capabilities.version;
    }

    // At least SafariDriver 2.41.0 fails to allow stand-alone feature
    // testing because it does not inject user scripts for URLs that are
    // not http/https
    if (isSafari(capabilities)) {
      if (isMac(capabilities)) {
        if (isValidVersion(capabilities, 0, 11)) {
          Object.assign(updates, {
            nativeEvents: false,
            rotatable: false,
            locationContextEnabled: false,
            webStorageEnabled: false,
            applicationCacheEnabled: false,
            supportsNavigationDataUris: true,
            supportsCssTransforms: true,
            supportsExecuteAsync: true,
            mouseEnabled: true,
            touchEnabled: false,
            dynamicViewport: true,
            shortcutKey: keys.COMMAND,

            // This must be set; running it as a server test will cause
            // SafariDriver to emit errors with the text "undefined is not
            // an object (evaluating 'a.postMessage')", and the session
            // will become unresponsive
            returnsFromClickImmediately: false,

            brokenDeleteCookie: false,
            brokenExecuteElementReturn: false,
            brokenExecuteUndefinedReturn: false,
            brokenElementDisplayedOpacity: false,
            brokenElementDisplayedOffscreen: false,
            brokenSubmitElement: true,
            brokenWindowSwitch: true,
            brokenDoubleClick: false,
            brokenCssTransformedSize: true,
            fixedLogTypes: false as const,
            brokenHtmlTagName: false,
            brokenNullGetSpecAttribute: false
          });
        }

        if (isValidVersion(capabilities, 0, 10)) {
          Object.assign(updates, {
            // SafariDriver, which shows versions up to 9.x, doesn't support file
            // uploads
            remoteFiles: false,

            brokenActiveElement: true,
            brokenExecuteForNonHttpUrl: true,
            brokenMouseEvents: true,
            brokenNavigation: true,
            brokenOptionSelect: false,
            brokenSendKeys: true,
            brokenWindowPosition: true,
            brokenWindowSize: true,

            // SafariDriver 2.41.0 cannot delete cookies, at all, ever
            brokenCookies: true
          });
        }

        if (isValidVersion(capabilities, 10, 12)) {
          Object.assign(updates, {
            brokenLinkTextLocator: true,
            // At least Safari 11 will hang on the brokenOptionSelect test
            brokenOptionSelect: true,
            brokenWhitespaceNormalization: true,
            brokenMouseEvents: true,
            brokenWindowClose: true,
            usesWebDriverActiveElement: true
          });
        }

        if (isValidVersion(capabilities, 12, 13)) {
          Object.assign(updates, {
            // At least Safari 12 uses W3C webdriver standard, including
            // /attribute/:attr
            usesWebDriverElementAttribute: true,
            // At least Safari 12 will sometimes close a tab or window other
            // than the current top-level browsing context when using DELETE
            // /window
            brokenDeleteWindow: true
          });
        }

        if (isValidVersion(capabilities, 13, Infinity)) {
          Object.assign(updates, {
            // At least Safari 13 clicks in the wrong location when clicking an
            // element.
            // See https://github.com/SeleniumHQ/selenium/issues/7649
            brokenClick: true,
            // At least Safari 13 on BrowserStack can become unresponsive when
            // the `buttonup` call is used.
            brokenMouseEvents: true,
            // Simulated events in Safari 13 do not change select values
            brokenOptionSelect: true,
            // Trying to close a window in Safari 13 will cause Safari to exit
            brokenWindowClose: true
          });
        }
      }

      // At least ios-driver 0.6.6-SNAPSHOT April 2014 corrupts its
      // internal state when performing window switches and gets
      // permanently stuck; we cannot feature detect, so platform
      // sniffing it is
      if (isIos(capabilities)) {
        updates.brokenWindowSwitch = true;
      }

      return updates;
    }

    if (isFirefox(capabilities)) {
      if (isValidVersion(capabilities, 49, Infinity)) {
        // The W3C WebDriver standard does not support the session-level
        // /keys command, but JsonWireProtocol does.
        updates.noKeysCommand = true;

        // Firefox 49+ (via geckodriver) only supports W3C locator
        // strategies
        updates.usesWebDriverLocators = true;

        // Non-W3C Firefox 49+ (via geckodriver) requires keys sent to an element
        // to be a flat array
        updates.usesFlatKeysArray = true;

        // At least Firefox 49 + geckodriver can't POST empty data
        updates.brokenEmptyPost = true;

        // At least geckodriver 0.11 and Firefox 49 don't implement mouse
        // control, so everything will need to be simulated.
        updates.brokenMouseEvents = true;

        // Firefox 49+ (via geckodriver) doesn't support retrieving logs or
        // log types, and may hang the session.
        updates.fixedLogTypes = [];
      }

      if (isValidVersion(capabilities, 49, 53)) {
        // At least geckodriver 0.15.0 and Firefox 51 will stop responding
        // to commands when performing window switches.
        updates.brokenWindowSwitch = true;
      }

      // Using mouse services such as doubleclick will hang Firefox 49+
      // session on the Mac.
      if (
        capabilities.mouseEnabled == null &&
        isValidVersion(capabilities, 49, Infinity) &&
        isMac(capabilities)
      ) {
        updates.mouseEnabled = true;
      }
    }

    if (isMsEdge(capabilities)) {
      // At least MS Edge 14316 returns immediately from a click request
      // immediately rather than waiting for default action to occur.
      updates.returnsFromClickImmediately = true;

      // At least MS Edge before 44.17763 may return an 'element is obscured'
      // error when trying to click on visible elements.
      if (isValidVersion(capabilities, 0, 44.17763)) {
        updates.brokenClick = true;
      }

      // File uploads don't work on Edge as of May 2017
      updates.remoteFiles = false;

      // At least MS Edge 10586 becomes unresponsive after calling DELETE
      // window, and window.close() requires user interaction. This
      // capability is distinct from brokenDeleteWindow as this capability
      // indicates that there is no way to close a Window.
      if (isValidVersion(capabilities, 25.10586)) {
        updates.brokenWindowClose = true;
      }

      // At least MS Edge Driver 14316 doesn't support sending keys to a file
      // input. See
      // https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/7194303/
      //
      // The existing feature test for this caused some browsers to hang, so
      // just flag it for Edge for now.
      if (isValidVersion(capabilities, 38.14366)) {
        updates.brokenFileSendKeys = true;
      }

      // At least MS Edge 14316 supports alerts but does not specify the
      // capability
      if (
        isValidVersion(capabilities, 37.14316) &&
        !('handlesAlerts' in capabilities)
      ) {
        updates.handlesAlerts = true;
      }

      // MS Edge 17763+ do not support the JWP execute commands. However, they
      // return a JavaScriptError rather than something indicating that the
      // command isn't supported.
      if (isValidVersion(capabilities, 44.17763)) {
        if (capabilities.usesWebDriverExecuteSync == null) {
          updates.usesWebDriverExecuteSync = true;
        }

        if (capabilities.usesWebDriverExecuteAsync == null) {
          updates.usesWebDriverExecuteAsync = true;
        }
      }

      // MS Edge < 18 (44.17763) doesn't properly support cookie deletion
      if (isValidVersion(capabilities, 0, 43)) {
        updates.brokenDeleteCookie = true;
      }
    }

    if (isInternetExplorer(capabilities)) {
      // Internet Explorer does not allow data URIs to be used for navigation
      updates.supportsNavigationDataUris = false;

      if (isValidVersion(capabilities, 10, Infinity)) {
        // At least IE10+ don't support the /frame/parent command
        updates.brokenParentFrameSwitch = true;
      }

      if (isValidVersion(capabilities, 11)) {
        // IE11 will take screenshots, but it's very slow
        updates.takesScreenshot = true;

        // IE11 will hang during this check if nativeEvents are enabled
        updates.brokenSubmitElement = true;

        // IE11 will hang during this check, but it does support window
        // switching
        updates.brokenWindowSwitch = false;

        // IE11 doesn't support the /frame/parent command
        updates.brokenParentFrameSwitch = true;
      }

      if (isValidVersion(capabilities, 11, Infinity)) {
        // At least IE11 will hang during this check, although option
        // selection does work with it
        updates.brokenOptionSelect = false;

        // At least IE11 will fail this feature test because it only supports
        // the POST endpoint for timeouts
        updates.supportsGetTimeouts = false;

        // At least IE11 will fail this feature test because it only supports
        // the POST endpoint for timeouts
        updates.brokenZeroTimeout = true;
      }

      // It is not possible to test this since the feature tests runs in
      // quirks-mode on IE<10, but we know that IE9 supports CSS transforms
      if (isValidVersion(capabilities, 9)) {
        updates.supportsCssTransforms = true;
      }

      // Internet Explorer 8 and earlier will simply crash the server if we
      // attempt to return the parent frame via script, so never even attempt
      // to do so
      updates.scriptedParentFrameCrashesBrowser = isValidVersion(
        capabilities,
        0,
        9
      );
    }

    // Don't check for touch support if the environment reports that no
    // touchscreen is available.
    if (capabilities.hasTouchScreen === false) {
      updates.touchEnabled = false;
    }

    updates.shortcutKey = (function () {
      if (isIos(capabilities)) {
        return null;
      }

      if (isMac(capabilities)) {
        return keys.COMMAND;
      }

      return keys.CONTROL;
    })();

    // At least selendroid 0.12.0-SNAPSHOT doesn't support switching to the
    // parent frame
    if (isAndroid(capabilities) && isAndroidEmulator(capabilities)) {
      updates.brokenParentFrameSwitch = true;
    }

    return updates;
  }

  /**
   * Run tests to detect capabilities/defects
   */
  private _detectCapabilities(session: Session): Promise<void | Session> {
    const capabilities = session.capabilities;
    const supported = () => true;
    const unsupported = () => false;
    const maybeSupported = (error: Error) => {
      if (error.name === 'UnknownCommand') {
        return false;
      }
      if (/\bunimplemented command\b/.test(error.message)) {
        return false;
      }
      if (/The command .* not found/.test(error.message)) {
        return false;
      }
      // At least Firefox 73 returns an error with the message "HTTP method not
      // allowed" when POSTing to touch endpoints
      if (/HTTP method not allowed/.test(error.message)) {
        return false;
      }
      return true;
    };
    const broken = supported;
    const works = unsupported;

    /**
     * Adds the capabilities listed in the `testedCapabilities` object to
     * the hash of capabilities for the current session. If a tested
     * capability value is a function, it is assumed that it still needs to
     * be executed serially in order to resolve the correct value of that
     * particular capability.
     */
    const addCapabilities = (testedCapabilities: Capabilities): Promise<void> =>
      Object.keys(testedCapabilities).reduce(
        (previous, key) =>
          previous.then(() => {
            const value = testedCapabilities[key];
            const promise =
              typeof value === 'function' ? value() : Promise.resolve(value);
            return promise.then((value: any) => {
              capabilities[key] = value;
            });
          }),
        Promise.resolve()
      );

    const get = (page: string) => {
      if (capabilities.supportsNavigationDataUris !== false) {
        return session.get(
          'data:text/html;charset=utf-8,' + encodeURIComponent(page)
        );
      }

      // Internet Explorer and Microsoft Edge build 10240 and earlier hang when
      // attempting to do navigate after a `document.write` is performed to
      // reset the tab content; we can still do some limited testing in these
      // browsers by using the initial browser URL page and injecting some
      // content through innerHTML, though it is unfortunately a quirks-mode
      // file so testing is limited
      if (isInternetExplorer(capabilities) || isMsEdge(capabilities)) {
        // Edge driver doesn't provide an initialBrowserUrl
        let initialUrl = 'about:blank';

        // As of version 3.3.0.1, IEDriverServer provides IE-specific
        // options, including the initialBrowserUrl, under an
        // 'se:ieOptions' property rather than directly on
        // capabilities.
        // https://github.com/SeleniumHQ/selenium/blob/e60b607a97b9b7588d59e0c26ef9a6d1d1350911/cpp/iedriverserver/CHANGELOG
        if (isInternetExplorer(capabilities) && capabilities['se:ieOptions']) {
          initialUrl = capabilities['se:ieOptions'].initialBrowserUrl;
        } else if (capabilities.initialBrowserUrl) {
          initialUrl = capabilities.initialBrowserUrl;
        }

        return session.get(initialUrl).then(function () {
          return session.execute<void>(
            'document.body.innerHTML = arguments[0];',
            [
              // The DOCTYPE does not apply, for obvious reasons, but
              // also old IE will discard invisible elements like
              // `<script>` and `<style>` if they are the first
              // elements injected with `innerHTML`, so an extra text
              // node is added before the rest of the content instead
              page.replace('<!DOCTYPE html>', 'x')
            ]
          );
        });
      }

      return session.get('about:blank').then(function () {
        return session.execute<void>('document.write(arguments[0]);', [page]);
      });
    };

    const logResult = (_message: string) => {
      return (value: any) =>
        // intern.log(`${message}: ${value}`).then(() => value);
        // pass through result
        value;
    };

    const discoverServerFeatures = () => {
      const testedCapabilities: any = {};

      // Check that the remote server will accept file uploads. There is
      // a secondary test in discoverDefects that checks whether the
      // server allows typing into file inputs.
      if (capabilities.remoteFiles == null) {
        // intern.log('Checking for remoteFiles...');
        testedCapabilities.remoteFiles = () =>
          // TODO: _post probably shouldn't be private
          session
            .serverPost<string>('file', {
              file:
                'UEsDBAoAAAAAAD0etkYAAAAAAAAAAAAA' +
                'AAAIABwAdGVzdC50eHRVVAkAA2WnXlVl' +
                'p15VdXgLAAEE8gMAAATyAwAAUEsBAh4D' +
                'CgAAAAAAPR62RgAAAAAAAAAAAAAAAAgA' +
                'GAAAAAAAAAAAAKSBAAAAAHRlc3QudHh0' +
                'VVQFAANlp15VdXgLAAEE8gMAAATyAwAA' +
                'UEsFBgAAAAABAAEATgAAAEIAAAAAAA=='
            })
            .then(filename => filename && filename.indexOf('test.txt') > -1)
            .catch(unsupported)
            .then(logResult('remoteFiles'));
      }

      if (capabilities.supportsSessionCommand == null) {
        // intern.log('Checking supportsSessionCommands...');
        testedCapabilities.supportsSessionCommands = () =>
          this.get('session/$0', undefined, [session.sessionId])
            .then(supported, unsupported)
            .then(logResult('supportsSessionCommands'));
      }

      if (capabilities.supportsGetTimeouts == null) {
        // intern.log('Checking supportsGetTimeouts...');
        testedCapabilities.supportsGetTimeouts = () => {
          return session
            .serverGet('timeouts')
            .then(supported, unsupported)
            .then(logResult('supportsGetTimeouts'));
        };
      }

      if (capabilities.usesWebDriverTimeouts == null) {
        // intern.log('Checking usesWebDriverTimeouts...');
        testedCapabilities.usesWebDriverTimeouts = () => {
          return (
            session
              // Try to set a timeout using W3C semantics
              .serverPost<void>('timeouts', { implicit: 1234 })
              .then(() => {
                // At least IE 11 on BrowserStack doesn't support GET for
                // timeouts. If we got here, though, the driver supports setting
                // W3C timeouts.
                if (isInternetExplorer(capabilities)) {
                  return supported();
                }

                // Verify that the timeout was set; at least Firefox 77 with
                // geckodriver 0.26 on BrowserStack will allow some properties
                // to be set using W3C-style data, but will fail to set the
                // `implicit` timeout this way. Note that IE11 doesn't support
                // GET for timeouts, so will always fail this test.
                return session
                  .serverGet<WebDriverTimeouts>('timeouts')
                  .then(timeouts => timeouts.implicit === 1234)
                  .catch(unsupported);
              }, unsupported)
              .then(logResult('usesWebDriverTimeouts'))
          );
        };
      }

      if (capabilities.usesWebDriverWindowCommands == null) {
        // intern.log('Checking usesWebDriverWindowCommands...');
        testedCapabilities.usesWebDriverWindowCommands = () =>
          session
            .serverGet('window/rect')
            .then(supported, unsupported)
            .then(logResult('usesWebDriverWindowCommands'));
      }

      // The W3C standard says window commands should take a 'handle'
      // parameter, while the JsonWireProtocol used a 'name' parameter.
      if (capabilities.usesHandleParameter == null) {
        // intern.log('Checking usesHandleParameter...');
        testedCapabilities.usesHandleParameter = () =>
          session
            .switchToWindow('current')
            .then(
              unsupported,
              error =>
                error.name === 'InvalidArgument' ||
                /missing .*handle/i.test(error.message)
            )
            .then(logResult('usesHandleParameter'));
      }

      // Sauce Labs will not return a list of sessions at least as of May
      // 2017
      if (capabilities.brokenSessionList == null) {
        // intern.log('Checking brokenSessionList...');
        testedCapabilities.brokenSessionList = () =>
          this.getSessions()
            .then(works, broken)
            .then(logResult('brokenSessionList'));
      }

      if (capabilities.returnsFromClickImmediately == null) {
        // intern.log('Checking returnsFromClickImmediately...');
        testedCapabilities.returnsFromClickImmediately = () => {
          function assertSelected(expected: any) {
            return function (actual: any) {
              if (expected !== actual) {
                throw new Error('unexpected selection state');
              }
            };
          }

          return get('<!DOCTYPE html><input type="checkbox" id="c">')
            .then(() => session.findById('c'))
            .then(element =>
              element
                .click()
                .then(() => element.isSelected())
                .then(assertSelected(true))
                .then(() => element.click().then(() => element.isSelected()))
                .then(assertSelected(false))
                .then(() => element.click().then(() => element.isSelected()))
                .then(assertSelected(true))
            )
            .then(works, broken)
            .then(logResult('returnsFromClickImmediately'));
        };
      }

      // The W3C WebDriver standard does not support the session-level
      // /keys command, but JsonWireProtocol does.
      if (capabilities.noKeysCommand == null) {
        // intern.log('Checking noKeysCommand...');
        testedCapabilities.noKeysCommand = () =>
          session
            .serverPost('keys', { value: ['a'] })
            .then(
              () => false,
              () => true
            )
            .then(logResult('noKeysCommand'));
      }

      // The W3C WebDriver standard does not support the /displayed endpoint
      if (capabilities.noElementDisplayed == null) {
        // intern.log('Checking noElementDisplayed...');
        testedCapabilities.noElementDisplayed = () =>
          session
            .findByCssSelector('html')
            .then(element => element.isDisplayed())
            .then(
              () => false,
              () => true
            )
            .then(logResult('noElementDisplayed'));
      }

      return Promise.all(
        Object.keys(testedCapabilities).map(key => testedCapabilities[key])
      ).then(() => testedCapabilities);
    };

    const discoverFeatures = () => {
      const testedCapabilities: any = {};

      // At least SafariDriver 2.41.0 fails to allow stand-alone feature
      // testing because it does not inject user scripts for URLs that
      // are not http/https
      if (isSafari(capabilities, 0, 10) && isMac(capabilities)) {
        // intern.log('Skipping feature tests for Mac Safari < 10');
        return Promise.resolve({});
      }

      // Appium iOS as of April 2014 supports rotation but does not
      // specify the capability
      if (capabilities.rotatable == null) {
        // intern.log('Checking rotatable...');
        testedCapabilities.rotatable = () =>
          session
            .getOrientation()
            .then(supported, unsupported)
            .then(logResult('rotatable'));
      }

      if (capabilities.locationContextEnabled) {
        // intern.log('Checking locationContextEnabled...');
        testedCapabilities.locationContextEnabled = () =>
          session
            .getGeolocation()
            .then(supported, function (error) {
              // At least FirefoxDriver 2.40.0 and ios-driver 0.6.0
              // claim they support geolocation in their returned
              // capabilities map, when they do not
              if (error.message.indexOf('not mapped : GET_LOCATION') !== -1) {
                return false;
              }

              // At least chromedriver 2.25 requires the location to
              // be set first. At least chromedriver 2.25 will throw
              // a CastClassException while trying to retrieve a
              // geolocation.
              if (error.message.indexOf('Location must be set') !== -1) {
                return session
                  .setGeolocation({
                    latitude: 12.1,
                    longitude: -22.33,
                    altitude: 1000.2
                  })
                  .then(() => session.getGeolocation())
                  .then(supported, unsupported);
              }

              return false;
            })
            .then(logResult('locationContextEnabled'));
      }

      // At least FirefoxDriver 2.40.0 claims it supports web storage in
      // the returned capabilities map, when it does not
      if (capabilities.webStorageEnabled) {
        // intern.log('Checking webStorageEnabled...');
        testedCapabilities.webStorageEnabled = () =>
          session
            .getLocalStorageLength()
            .then(supported, maybeSupported)
            .then(logResult('webStorageEnabled'));
      }

      // At least FirefoxDriver 2.40.0 claims it supports application
      // cache in the returned capabilities map, when it does not
      if (capabilities.applicationCacheEnabled) {
        // intern.log('Checking applicationCacheEnabled...');
        testedCapabilities.applicationCacheEnabled = () =>
          session
            .getApplicationCacheStatus()
            .then(supported, maybeSupported)
            .then(logResult('applicationCacheEnabled'));
      }

      if (capabilities.takesScreenshot == null) {
        // At least Selendroid 0.9.0 will fail to take screenshots in
        // certain device configurations, usually emulators with
        // hardware acceleration enabled
        // intern.log('Checking takesScreenshot...');
        testedCapabilities.takesScreenshot = () =>
          session
            .takeScreenshot()
            .then(supported, unsupported)
            .then(logResult('takesScreenshot'));
      }

      // At least ios-driver 0.6.6-SNAPSHOT April 2014 does not support
      // execute_async
      if (capabilities.supportsExecuteAsync == null) {
        // intern.log('Checking supportsExecuteAsync...');
        testedCapabilities.supportsExecuteAsync = () =>
          session
            .executeAsync<boolean>('arguments[0](true);')
            .catch(unsupported)
            .then(logResult('supportsExecuteAsync'));
      }

      // Using mouse services such as doubleclick will hang Firefox 49+
      // session on the Mac.
      if (
        capabilities.mouseEnabled == null &&
        !(isFirefox(capabilities, 49, Infinity) && isMac(capabilities))
      ) {
        // intern.log('Checking mouseEnabled...');
        testedCapabilities.mouseEnabled = () =>
          get('<!DOCTYPE html><button id="clicker">Click me</button>')
            .then(() => session.findById('clicker'))
            .then(button => button.click().then(supported, maybeSupported))
            .catch(unsupported)
            .then(logResult('mouseEnabled'));
      }

      if (capabilities.touchEnabled == null) {
        // intern.log('Checking touchEnabled...');
        testedCapabilities.touchEnabled = () =>
          get('<!DOCTYPE html><button id="clicker">Click me</button>')
            .then(() => session.findById('clicker'))
            .then(button =>
              session.doubleTap(button).then(supported, maybeSupported)
            )
            .catch(unsupported)
            .then(logResult('touchEnabled'));
      }

      if (capabilities.dynamicViewport == null) {
        // intern.log('Checking dynamicViewport...');
        testedCapabilities.dynamicViewport = () =>
          session
            .getWindowSize()
            .then(originalSize =>
              // At least Firefox 53 will hang if the target size is
              // the same as the current size
              session.setWindowSize(
                originalSize.width - 2,
                originalSize.height - 2
              )
            )
            .then(supported, unsupported)
            .then(logResult('dynamicViewport'));
      }

      // At least Internet Explorer 11 and earlier do not allow data URIs
      // to be used for navigation
      if (capabilities.supportsNavigationDataUris == null) {
        // intern.log('Checking supportsNavigationDataUris...');
        testedCapabilities.supportsNavigationDataUris = () =>
          get('<!DOCTYPE html><title>a</title>')
            .then(() => session.getPageTitle())
            .then(pageTitle => pageTitle === 'a')
            .catch(unsupported)
            .then(logResult('supportsNavigationDataUris'));
      }

      if (capabilities.supportsCssTransforms == null) {
        // intern.log('Checking supportsCssTransforms...');
        testedCapabilities.supportsCssTransforms = () =>
          get(
            '<!DOCTYPE html><style>' +
              '#a{width:8px;height:8px;-ms-transform:scale(0.5);' +
              '-moz-transform:scale(0.5);-webkit-transform:scale(0.5);' +
              'transform:scale(0.5);}</style><div id="a"></div>'
          )
            .then<boolean>(() =>
              session.execute(
                /* istanbul ignore next */ function () {
                  const bbox = document
                    .getElementById('a')!
                    .getBoundingClientRect();
                  return bbox.right - bbox.left === 4;
                }
              )
            )
            .catch(unsupported)
            .then(logResult('supportsCssTransforms'));
      }

      if (capabilities.usesWebDriverMoveBase == null) {
        testedCapabilities.usesWebDriverMoveBase = () => {
          return get(
            `<!DOCTYPE html><html><body style="width:100%;height:100px;">
              <script>
                var events = [];
                document.onmousemove = function (event) {
                  events.push({
                    x: event.clientX,
                    y: event.clientY
                  });
                };
              </script>
            </body></html>
            `
          )
            .then(() => session.moveMouseTo(100, 50))
            .then(() =>
              session.execute<{ x: number; y: number }[]>(
                'return window.events'
              )
            )
            .then(events => {
              if (!events) {
                return undefined;
              }
              const event = events[0];
              // Webdriver's move base is the element center, whereas JWP uses
              // the top left corner. Here the element is the document body, so
              // if x == 100, it's JWP, otherwise it's probably webdriver.
              return event.x !== 100;
            });
        };
      }

      return Promise.all(
        Object.keys(testedCapabilities).map(key => testedCapabilities[key])
      ).then(() => testedCapabilities);
    };

    const discoverDefects = (): Promise<Capabilities> => {
      const testedCapabilities: any = {};

      // At least SafariDriver 2.41.0 fails to allow stand-alone feature
      // testing because it does not inject user scripts for URLs that
      // are not http/https
      if (isSafari(capabilities, 0, 10) && isMac(capabilities)) {
        // intern.log('Skipping defect tests for Mac Safari < 10');
        return Promise.resolve({});
      }

      // At least ChromeDriver 2.9 and MS Edge 10240 does not implement
      // /element/active
      if (capabilities.brokenActiveElement == null) {
        // intern.log('Checking for brokenActiveElement...');
        testedCapabilities.brokenActiveElement = () =>
          session
            .getActiveElement()
            .then(works, error => error.name === 'UnknownCommand')
            .then(logResult('brokenActiveElement'));
      }

      if (capabilities.brokenDeleteCookie == null) {
        if (capabilities.browserName === 'selendroid') {
          // At least Selendroid 0.9.0 has broken cookie deletion.
          // This test is very hard to get working properly in other
          // environments so only test when Selendroid is the browser
          // intern.log('Checking for brokenDeleteCookie...');
          testedCapabilities.brokenDeleteCookie = () =>
            session
              .get('about:blank')
              .then(() => session.clearCookies())
              .then(() =>
                session.setCookie({
                  name: 'foo',
                  value: 'foo'
                })
              )
              .then(() => session.deleteCookie('foo'))
              .then(() => session.getCookies())
              .then(cookies => cookies.length > 0)
              .catch(() => true)
              .then(isBroken =>
                session.clearCookies().then(
                  () => isBroken,
                  () => isBroken
                )
              )
              .then(logResult('brokenDeleteCookie'));
        } else {
          // At least MS Edge < 18 doesn't support cookie deletion
          // intern.log('Checking for brokenDeleteCookie...');
          testedCapabilities.brokenDeleteCookie = () =>
            session
              .get('about:blank')
              .then(() => session.clearCookies())
              .then(works, broken)
              .then(logResult('brokenDeleteCookie'));
        }
      }

      // At least Selendroid 0.9.0 incorrectly returns HTML tag names in
      // uppercase, which is a violation of the JsonWireProtocol spec
      if (capabilities.brokenHtmlTagName == null) {
        // intern.log('Checking for brokenHtmlTagName...');
        testedCapabilities.brokenHtmlTagName = () =>
          session
            .findByTagName('html')
            .then(element => element.getTagName())
            .then(tagName => tagName !== 'html')
            .catch(broken)
            .then(logResult('brokenHtmlTagName'));
      }

      // At least ios-driver 0.6.6-SNAPSHOT incorrectly returns empty
      // string instead of null for attributes that do not exist
      if (capabilities.brokenNullGetSpecAttribute == null) {
        // intern.log('Checking for brokenNullGetSpecAttribute...');
        testedCapabilities.brokenNullGetSpecAttribute = () =>
          session
            .findByTagName('html')
            .then(element => element.getSpecAttribute('nonexisting'))
            .then(value => value !== null)
            .catch(broken)
            .then(logResult('brokenNullGetSpecAttribute'));
      }

      // At least MS Edge 10240 doesn't properly deserialize web elements
      // passed as `execute` arguments
      if (capabilities.brokenElementSerialization == null) {
        // intern.log('Checking for brokenElementSerialization...');
        testedCapabilities.brokenElementSerialization = () =>
          get('<!DOCTYPE html><div id="a"></div>')
            .then(() => session.findById('a'))
            .then(element =>
              session.execute(
                /* istanbul ignore next */
                function (element: Element) {
                  return element.getAttribute('id');
                },
                [element]
              )
            )
            .then(attribute => attribute !== 'a')
            .catch(broken)
            .then(logResult('brokenElementSerialization'));
      }

      // At least Selendroid 0.16.0 incorrectly returns `undefined`
      // instead of `null` when an undefined value is returned by an
      // `execute` call
      if (capabilities.brokenExecuteUndefinedReturn == null) {
        // intern.log('Checking for brokenExecuteUndefinedReturn...');
        testedCapabilities.brokenExecuteUndefinedReturn = () =>
          session
            .execute('return undefined;')
            .then(value => value !== null, broken)
            .then(logResult('brokenExecuteUndefinedReturn'));
      }

      // At least Selendroid 0.9.0 always returns invalid element handles
      // from JavaScript
      if (capabilities.brokenExecuteElementReturn == null) {
        // intern.log('Checking for brokenExecuteElementReturn...');
        testedCapabilities.brokenExecuteElementReturn = () =>
          get('<!DOCTYPE html><div id="a"></div>')
            .then(() =>
              session.execute<Element>('return document.getElementById("a");')
            )
            .then(element => element && element.getTagName())
            .then(works, broken)
            .then(logResult('brokenExecuteElementReturn'));
      }

      // At least Selendroid 0.9.0 treats fully transparent elements as
      // displayed, but all others do not
      if (capabilities.brokenElementDisplayedOpacity == null) {
        // intern.log('Checking for brokenElementDisplayedOpacity...');
        testedCapabilities.brokenElementDisplayedOpacity = () =>
          get('<!DOCTYPE html><div id="a" style="opacity: .1;">a</div>')
            .then(() =>
              // IE<9 do not support CSS opacity so should not be
              // involved in this test
              session.execute(
                'var o = document.getElementById("a").style.opacity; return o && o.charAt(0) === "0";'
              )
            )
            .then(supportsOpacity => {
              if (!supportsOpacity) {
                return works();
              } else {
                return session
                  .execute('document.getElementById("a").style.opacity = "0";')
                  .then(() => session.findById('a'))
                  .then(element => element.isDisplayed());
              }
            })
            .catch(broken)
            .then(logResult('brokenElementDisplayedOpacity'));
      }

      // At least ChromeDriver 2.9 treats elements that are offscreen as
      // displayed, but others do not
      if (capabilities.brokenElementDisplayedOffscreen == null) {
        // intern.log('Checking for brokenElementDisplayedOffscreen...');
        testedCapabilities.brokenElementDisplayedOffscreen = () => {
          const pageText =
            '<!DOCTYPE html><div id="a" style="left: 0; position: absolute; top: -1000px;">a</div>';
          return get(pageText)
            .then(() => session.findById('a'))
            .then(element => element.isDisplayed())
            .catch(broken)
            .then(logResult('brokenElementDisplayedOffscreen'));
        };
      }

      // The feature test for this causes some browsers to hang, so it's
      // just flagged directly for Edge for now.
      // testedCapabilities.brokenFileSendKeys = function () {
      // 	return get('<!DOCTYPE html><input type="file" id="i1">').then(function () {
      // 		var element;
      // 		return session.findById('i1')
      // 			.then(function (element) {
      // 				return element.type('./Server.js');
      // 			}).then(function () {
      // 				return session.execute(function () {
      // 					return document.getElementById('i1').value;
      // 				});
      // 			}).then(function (text) {
      // 				if (!/Server.js$/.test(text)) {
      // 					throw new Error('mismatch');
      // 				}
      // 			});
      // 	}).then(works, broken);
      // };

      // At least Safari 11-12 include non-rendered text when retrieving
      // "visible" text.
      if (capabilities.brokenVisibleText == null) {
        // intern.log('Checking for brokenVisibleText...');
        testedCapabilities.brokenVisibleText = () =>
          get(
            '<!DOCTYPE html><div id="d">This is<span style="display:none"> really</span> great</div>'
          )
            .then(() =>
              session
                .findById('d')
                .then(element => element.getVisibleText())
                .then(text => {
                  if (text !== 'This is great') {
                    throw new Error('Incorrect text');
                  }
                })
            )
            .then(works, broken)
            .then(logResult('brokenVisibleText'));
      }

      // At least MS Edge Driver 14316 doesn't normalize whitespace
      // properly when retrieving text. Text may contain "\r\n" pairs
      // rather than "\n", and there may be extraneous whitespace
      // adjacent to "\r\n" pairs and at the start and end of the text.
      if (capabilities.brokenWhitespaceNormalization == null) {
        // intern.log('Checking for brokenWhitespaceNormalization...');
        testedCapabilities.brokenWhitespaceNormalization = () =>
          get('<!DOCTYPE html><div id="d">This is\n<br>a test\n</div>')
            .then(() =>
              session
                .findById('d')
                .then(element => element.getVisibleText())
                .then(text => {
                  if (/\r\n/.test(text) || /\s+$/.test(text)) {
                    throw new Error('invalid whitespace');
                  }
                })
            )
            .then(works, broken)
            .then(logResult('brokenWhitespaceNormalization'));
      }

      // At least geckodriver 0.15.0 and Firefox 51.0.1 don't properly
      // normalize link text when using the 'link text' locator strategy.
      if (capabilities.brokenLinkTextLocator == null) {
        // intern.log('Checking for brokenLinkTextLocator...');
        testedCapabilities.brokenLinkTextLocator = () =>
          get(
            '<!DOCTYPE html><a id="d">What a cute<span style="display:none">, ' +
              'yellow</span> backpack</a><a id="e">What a cute, yellow backpack</a>'
          )
            .then(() =>
              session
                .findByLinkText('What a cute, yellow backpack')
                .then(element => element.getAttribute('id'))
                .then(attr => {
                  if (attr !== 'e') {
                    throw new Error('incorrect link was found');
                  }
                })
            )
            .then(works, broken)
            .then(logResult('brokenLinkTextLocator'));
      }

      // At least MS Edge Driver 14316 doesn't return elements' computed
      // styles
      if (capabilities.brokenComputedStyles == null) {
        // intern.log('Checking for brokenComputedStyles...');
        testedCapabilities.brokenComputedStyles = () => {
          const pageText =
            '<!DOCTYPE html><style>a { background: purple }</style><a id="a1">foo</a>';
          return get(pageText)
            .then(() => session.findById('a1'))
            .then(element => element.getComputedStyle('background-color'))
            .then(value => {
              if (!value) {
                throw new Error('empty style');
              }
            })
            .then(works, broken)
            .then(logResult('brokenLinkStyles'));
        };
      }

      if (capabilities.brokenOptionSelect == null) {
        // At least MS Edge Driver 14316 doesn't allow selection
        // option elements to be clicked.
        // intern.log('Checking for brokenOptionSelect...');
        testedCapabilities.brokenOptionSelect = () =>
          get(
            '<!DOCTYPE html><select id="d"><option id="o1" value="foo">foo</option>' +
              '<option id="o2" value="bar" selected>bar</option></select>'
          )
            .then(() => session.findById('d'))
            .then(element => element.click())
            .then(() => session.findById('o1'))
            .then(element => element.click())
            .then(works, broken)
            .then(logResult('brokenOptionSelect'));
      }

      // At least MS Edge driver 10240 doesn't support getting the page
      // source
      if (capabilities.brokenPageSource == null) {
        // intern.log('Checking brokenPageSource...');
        testedCapabilities.brokenPageSource = () =>
          session
            .getPageSource()
            .then(works, broken)
            .then(logResult('brokenPageSource'));
      }

      if (capabilities.brokenSubmitElement == null) {
        // There is inconsistency across all drivers as to whether or
        // not submitting a form button should cause the form button to
        // be submitted along with the rest of the form; it seems most
        // likely that tests do want the specified button to act as
        // though someone clicked it when it is submitted, so the
        // behaviour needs to be normalised
        // intern.log('Checking brokenSubmitElement...');
        testedCapabilities.brokenSubmitElement = () =>
          get(
            '<!DOCTYPE html><form method="get" action="about:blank">' +
              '<input id="a" type="submit" name="a" value="a"></form>'
          )
            .then(() => session.findById('a'))
            .then(element => element.submit())
            .then(() => session.getCurrentUrl())
            .then(url => url.indexOf('a=a') === -1)
            .catch(broken)
            .then(logResult('brokenSubmitElement'));
      }

      // At least MS Edge driver 10240 doesn't support window sizing
      // commands
      if (capabilities.brokenWindowSize == null) {
        // intern.log('Checking brokenWindowSize...');
        testedCapabilities.brokenWindowSize = () =>
          session
            .getWindowSize()
            .then(works, broken)
            .then(logResult('brokenWindowSize'));
      }

      // At least Chrome on Mac doesn't properly maximize. See
      // https://bugs.chromium.org/p/chromedriver/issues/detail?id=985
      if (capabilities.brokenWindowMaximize == null) {
        // intern.log('Checking brokenWindowMaximize...');
        testedCapabilities.brokenWindowMaximize = () => {
          let originalSize: { width: number; height: number };
          let newSize: { width: number; height: number };
          return session
            .getWindowSize()
            .then(size => {
              originalSize = size;
              return session.setWindowSize(size.width - 10, size.height - 10);
            })
            .then(() => session.maximizeWindow())
            .then(() => session.getWindowSize())
            .then(size => {
              newSize = size;
            })
            .then(() => {
              return session.setWindowSize(
                originalSize.width,
                originalSize.height
              );
            })
            .then(
              () =>
                newSize.width > originalSize.width &&
                newSize.height > originalSize.height
            )
            .catch(broken)
            .then(logResult('brokenWindowMaximize'));
        };
      }

      // At least Selendroid 0.9.0 has a bug where it catastrophically
      // fails to retrieve available types; they have tried to hardcode
      // the available log types in this version so we can just return
      // the same hardcoded list ourselves.
      // At least InternetExplorerDriver 2.41.0 also fails to provide log
      // types. Firefox 49+ (via geckodriver) doesn't support retrieving
      // logs or log types, and may hang the session.
      if (capabilities.fixedLogTypes == null) {
        // intern.log('Checking fixedLogTypes...');
        testedCapabilities.fixedLogTypes = () =>
          session
            .getAvailableLogTypes()
            .then(unsupported, (error: LeadfootError) => {
              if (
                capabilities.browserName === 'selendroid' &&
                error.response!.text.length === 0
              ) {
                return ['logcat'];
              }

              return [];
            })
            .then(logResult('fixedLogTypes'));
      }

      // At least Microsoft Edge 10240 doesn't support timeout values of
      // 0.
      if (capabilities.brokenZeroTimeout == null) {
        // intern.log('Checking brokenZeroTimeout...');
        testedCapabilities.brokenZeroTimeout = () =>
          session
            .setTimeout('implicit', 0)
            .then(works, broken)
            .then(logResult('brokenZeroTimeout'));
      }

      if (capabilities.brokenWindowSwitch == null) {
        // intern.log('Checking brokenWindowSwitch...');
        testedCapabilities.brokenWindowSwitch = () =>
          session
            .getCurrentWindowHandle()
            .then(handle => session.switchToWindow(handle))
            .then(works, broken)
            .then(logResult('brokenWindowSwitch'));
      }

      if (capabilities.brokenParentFrameSwitch == null) {
        // intern.log('Checking brokenParentFrameSwitch...');
        testedCapabilities.brokenParentFrameSwitch = () =>
          session
            .serverPost('frame/parent')
            .then(works, broken)
            .then(logResult('brokenParentFrameSwitch'));
      }

      // This URL is used by several tests below
      const scrollTestUrl =
        '<!DOCTYPE html><div id="a" style="margin: 3000px;"></div>';

      // ios-driver 0.6.6-SNAPSHOT April 2014 calculates position based
      // on a bogus origin and does not account for scrolling
      if (capabilities.brokenElementPosition == null) {
        // intern.log('Checking brokenElementPosition...');
        testedCapabilities.brokenElementPosition = () =>
          get(scrollTestUrl)
            .then(() => session.findById('a'))
            .then(element => element.getPosition())
            .then(position => position.x !== 3000 || position.y !== 3000)
            .catch(broken)
            .then(logResult('brokenElementPosition'));
      }

      // At least ios-driver 0.6.6-SNAPSHOT April 2014 will never
      // complete a refresh call
      if (capabilities.brokenRefresh == null) {
        // intern.log('Checking brokenRefresh...');
        testedCapabilities.brokenRefresh = () =>
          session
            .get('about:blank?1')
            .then(() => {
              let timer: NodeJS.Timer;
              let refresh: Promise<boolean | void>;
              const isBroken = true;
              const notBroken = false;

              return new Promise(resolve => {
                refresh = session.refresh().then(
                  () => {
                    clearTimeout(timer);
                    resolve(notBroken);
                  },
                  () => {
                    clearTimeout(timer);
                    resolve(isBroken);
                  }
                );

                const timeout = new Promise((_resolve, reject) => {
                  timer = setTimeout(reject, 2000);
                });

                // If the timeout promise finishes first, resolve the promise
                // as true
                Promise.race([refresh, timeout])
                  .then(resolve, () => {
                    resolve(isBroken);
                  })
                  .then(() => clearTimeout(timer));
              });
            })
            .catch(broken)
            .then(logResult('brokenRefresh'));
      }

      if (capabilities.brokenMouseEvents == null && capabilities.mouseEnabled) {
        // At least IE 10 and 11 on SauceLabs don't fire native mouse
        // events consistently even though they support moveMouseTo
        // intern.log('Checking brokenMouseEvents...');
        testedCapabilities.brokenMouseEvents = () =>
          get(
            '<!DOCTYPE html><div id="foo">foo</div>' +
              '<script>window.counter = 0; var d = document; d.onmousemove = function () { window.counter++; };</script>'
          )
            .then(() => session.findById('foo'))
            .then(element => session.moveMouseTo(element, 20, 20))
            .then(() => sleep(100))
            .then(() => session.execute<number>('return window.counter;'))
            .then(counter => (counter > 0 ? works() : broken()), broken)
            .then(logResult('brokenMouseEvents'));

        // At least ChromeDriver 2.12 through 2.19 will throw an error
        // if mouse movement relative to the <html> element is
        // attempted
        if (capabilities.brokenHtmlMouseMove == null) {
          // intern.log('Checking brokenHtmlMouseMove...');
          testedCapabilities.brokenHtmlMouseMove = () =>
            get('<!DOCTYPE html><html></html>')
              .then(() =>
                session
                  .findByTagName('html')
                  .then(element => session.moveMouseTo(element, 0, 0))
              )
              .then(works, broken)
              .then(logResult('brokenHtmlMouseMove'));
        }
      }

      // At least ChromeDriver 2.9.248307 does not correctly emit the
      // entire sequence of events that would normally occur during a
      // double-click
      if (capabilities.brokenDoubleClick == null) {
        // intern.log('Checking brokenDoubleClick...');
        testedCapabilities.brokenDoubleClick = function retry(): Promise<any> {
          // InternetExplorerDriver is not buggy, but IE9 in
          // quirks-mode is; since we cannot do feature tests in
          // standards-mode in IE<10, force the value to false
          // since it is not broken in this browser
          if (
            capabilities.browserName === 'internet explorer' &&
            capabilities.browserVersion === '9'
          ) {
            return Promise.resolve(false);
          }

          return get(
            '<!DOCTYPE html><html><body><button id="clicker">Clicker</button><script>' +
              'window.counter = 0; var d = document; d.onclick = ' +
              'd.onmousedown = d.onmouseup = function () { window.counter++; };' +
              '</script></body></html>'
          )
            .then(() => session.findById('clicker'))
            .then(element => session.moveMouseTo(element))
            .then(() => sleep(100))
            .then(() => session.doubleClick())
            .then(() => session.execute('return window.counter;'))
            .then(counter => {
              // InternetExplorerDriver 2.41.0 has a race
              // condition that makes this test sometimes
              // fail
              /* istanbul ignore if: inconsistent race condition */
              if (counter === 0) {
                return retry();
              }

              return counter !== 6;
            })
            .catch(broken)
            .then(logResult('brokenDoubleClick'));
        };
      }

      if (capabilities.touchEnabled) {
        // At least Selendroid 0.9.0 fails to perform a long tap due to
        // an INJECT_EVENTS permission failure
        if (capabilities.brokenLongTap == null) {
          // intern.log('Checking brokenLongTap...');
          testedCapabilities.brokenLongTap = () =>
            session
              .findByTagName('body')
              .then(element => session.longTap(element))
              .then(works, broken)
              .then(logResult('brokenLongTap'));

          // At least ios-driver 0.6.6-SNAPSHOT April 2014 claims to
          // support touch press/move/release but actually fails when you
          // try to use the commands
          if (capabilities.brokenMoveFinger == null) {
            // intern.log('Checking brokenMoveFinger...');
            testedCapabilities.brokenMoveFinger = () =>
              session
                .pressFinger(0, 0)
                .then(
                  works,
                  error =>
                    error.name === 'UnknownCommand' ||
                    error.message.indexOf('need to specify the JS') > -1
                )
                .then(logResult('brokenMoveFinger'));
          }

          // Touch scroll in ios-driver 0.6.6-SNAPSHOT is broken, does
          // not scroll at all; in selendroid 0.9.0 it ignores the
          // element argument
          if (capabilities.brokenTouchScroll == null) {
            // intern.log('Checking brokenTouchScroll...');
            testedCapabilities.brokenTouchScroll = () =>
              get(scrollTestUrl)
                .then(() => session.touchScroll(0, 20))
                .then(() => session.execute('return window.scrollY !== 20;'))
                .then(isBroken => {
                  if (isBroken) {
                    return true;
                  }

                  return session
                    .findById('a')
                    .then(element => session.touchScroll(element, 0, 0))
                    .then(() =>
                      session.execute('return window.scrollY !== 3000;')
                    );
                })
                .catch(broken)
                .then(logResult('brokenTouchScroll'));
          }
        }

        // Touch flick in ios-driver 0.6.6-SNAPSHOT is broken, does not
        // scroll at all except in very broken ways if very tiny speeds
        // are provided and the flick goes in the wrong direction
        if (capabilities.brokenFlickFinger == null) {
          // intern.log('Checking brokenFlickFinger...');
          testedCapabilities.brokenFlickFinger = () =>
            get(scrollTestUrl)
              .then(() => session.flickFinger(0, 400))
              .then(() => session.execute('return window.scrollY === 0;'))
              .catch(broken)
              .then(logResult('brokenFlickFinger'));
        }
      }

      if (
        capabilities.supportsCssTransforms &&
        capabilities.brokenCssTransformedSize == null
      ) {
        // intern.log('Checking brokenCssTransformedSize...');
        testedCapabilities.brokenCssTransformedSize = () =>
          get(
            '<!DOCTYPE html><style>#a{width:8px;height:8px;' +
              '-ms-transform:scale(0.5);-moz-transform:scale(0.5);' +
              '-webkit-transform:scale(0.5);transform:scale(0.5);}' +
              '</style><div id="a"></div>'
          )
            .then(() =>
              session
                .execute<Element>('return document.getElementById("a");')
                .then(element => element.getSize())
                .then(
                  dimensions =>
                    dimensions.width !== 4 || dimensions.height !== 4
                )
            )
            .catch(broken)
            .then(logResult('brokenCssTransformedSize'));
      }

      // This test will cause at least Edge 18 (44) to hang
      if (!isMsEdge(capabilities)) {
        // At least Safari 12 isn't properly detecting disabled elements
        if (capabilities.brokenElementEnabled == null) {
          // intern.log('Checking brokenElementEnabled...');
          testedCapabilities.brokenElementEnabled = () =>
            get('<!DOCTYPE html><input id="dis" type="text" disabled>')
              .then(() =>
                session
                  .execute<Element>('return document.getElementById("dis");')
                  .then(element => element.isEnabled())
                  .then(isEnabled => (isEnabled ? broken() : works()))
                  .catch(broken)
              )
              .then(logResult('brokenElementEnabled'));
        }
      }

      return Promise.all(
        Object.keys(testedCapabilities).map(key => testedCapabilities[key])
      ).then(() => testedCapabilities);
    };

    if (capabilities._filled) {
      return Promise.resolve(session);
    }

    // At least geckodriver 0.11 and Firefox 49+ may hang when getting
    // 'about:blank' in the first request
    const promise: Promise<Session | void> = isFirefox(
      capabilities,
      49,
      Infinity
    )
      ? Promise.resolve(session)
      : session.get('about:blank');

    return promise
      .then(discoverServerFeatures)
      .then(addCapabilities)
      .then(discoverFeatures)
      .then(addCapabilities)
      .then(() => session.get('about:blank'))
      .then(discoverDefects)
      .then(addCapabilities)
      .then(() => session.get('about:blank'))
      .then(() => session);
  }

  /**
   * Gets a list of all currently active remote control sessions on this
   * server.
   */
  getSessions(): Promise<Session[]> {
    return this.get('sessions').then(function (sessions: any) {
      // At least BrowserStack is now returning an array for the sessions
      // response
      if (sessions && !Array.isArray(sessions)) {
        sessions = returnValue(sessions);
      }

      // At least ChromeDriver 2.19 uses the wrong keys
      // https://code.google.com/p/chromedriver/issues/detail?id=1229
      sessions.forEach(function (session: any) {
        if (session.sessionId && !session.id) {
          session.id = session.sessionId;
        }
      });

      return sessions;
    });
  }

  /**
   * Gets information on the capabilities of a given session from the server.
   * The list of capabilities returned by this command will not include any
   * of the extra session capabilities detected by Leadfoot and may be
   * inaccurate.
   */
  getSessionCapabilities(sessionId: string): Promise<Capabilities> {
    return this.get('session/$0', undefined, [sessionId]).then(returnValue);
  }

  /**
   * Terminates a session on the server.
   */
  deleteSession(sessionId: string) {
    return this.delete<void>('session/$0', undefined, [sessionId]).then(noop);
  }
}

function getErrorName(error: { name: string; detail: { error: string } }) {
  if (
    // Most browsers use 'Error' as the generic error name, but at least Safari
    // 12 uses 'UnknownError'
    (error.name !== 'Error' && error.name !== 'UnknownError') ||
    !error.detail ||
    !error.detail.error
  ) {
    return error.name;
  }

  // desc will be something like 'javascript error' or 'no such window'
  const desc = error.detail.error;

  // 'javascript error' is a special case because of...case (javascript ->
  // JavaScript)
  if (desc === 'javascript error') {
    return 'JavaScriptError';
  }

  // For other error descriptions, just combine the description words into a
  // Pascal case name
  return desc
    .split(' ')
    .map(word => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join('');
}

function isAndroid(capabilities: Capabilities) {
  const { browserName = '' } = capabilities;
  return browserName.toLowerCase() === 'android';
}

function isAndroidEmulator(capabilities: Capabilities) {
  const { deviceName = '' } = capabilities;
  return deviceName.toLowerCase() === 'android emulator';
}

function isIos(capabilities: Capabilities) {
  const { platform = '', platformName = '' } = capabilities;
  return (platformName || platform).toLowerCase() === 'ios';
}

function isMac(capabilities: Capabilities) {
  const { platform = '', platformName = '' } = capabilities;
  const _platform = platform || platformName;
  return (
    (/mac(os)?/i.test(_platform) || /darwin/i.test(_platform)) &&
    _platform.toLowerCase() !== 'ios'
  );
}

export function isMsEdge(
  capabilities: Capabilities,
  minOrExactVersion?: number,
  maxVersion?: number
) {
  const { browserName = '' } = capabilities;
  if (browserName.toLowerCase() !== 'microsoftedge') {
    return false;
  }

  return isValidVersion(capabilities, minOrExactVersion, maxVersion);
}

export function isInternetExplorer(
  capabilities: Capabilities,
  minOrExactVersion?: number,
  maxVersion?: number
) {
  const { browserName = '' } = capabilities;
  if (browserName.toLowerCase() !== 'internet explorer') {
    return false;
  }

  return isValidVersion(capabilities, minOrExactVersion, maxVersion);
}

export function isSafari(
  capabilities: Capabilities,
  minOrExactVersion?: number,
  maxVersion?: number
) {
  const { browserName = '' } = capabilities;
  if (browserName.toLowerCase() !== 'safari') {
    return false;
  }

  return isValidVersion(capabilities, minOrExactVersion, maxVersion);
}

export function isFirefox(
  capabilities: Capabilities,
  minOrExactVersion?: number,
  maxVersion?: number
) {
  const { browserName = '' } = capabilities;
  if (browserName.toLowerCase() !== 'firefox') {
    return false;
  }

  return isValidVersion(capabilities, minOrExactVersion, maxVersion);
}

/**
 * Check if a browserVersion is between a min (inclusive) and a max
 * (exclusive). If only one version is specified, it is treated as an exact
 * match.
 */
function isValidVersion(
  capabilities: Capabilities,
  minOrExactVersion?: number,
  maxVersion?: number
) {
  if (minOrExactVersion != null) {
    const version = parseFloat(
      (capabilities.browserVersion || capabilities.version)!
    );

    if (maxVersion != null) {
      if (version < minOrExactVersion) {
        return false;
      }
      if (version >= maxVersion) {
        return false;
      }
    } else if (version !== minOrExactVersion) {
      return false;
    }
  }

  return true;
}

function noop() {}

/**
 * Returns the actual response value from the remote environment.
 *
 * @param response JsonWireProtocol response object.
 * @returns The actual response value.
 */
function returnValue(response: any): any {
  return response.value;
}

interface ResponseData {
  response: Response;
  data: any;
}
