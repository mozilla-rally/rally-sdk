/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const CORE_ADDON_ID = "rally-core@mozilla.org";
const SIGNUP_URL = "https://rally.mozilla.org/rally-required";

import { browser, Runtime } from "webextension-polyfill-ts";

interface CoreCheckResponse {
  type: string;
  data: {
    enrolled: boolean;
    rallyId: string | null;
  }
}

export const runStates = {
  RUNNING: "running",
  PAUSED: "paused",
}

export class Rally {
  private _namespace: string;
  private _keyId: string;
  private _key: { kid: string };
  private _enableDevMode: boolean;
  private _rallyId: string | null;
  private _state: string;
  private _initialized: boolean;

  /**
   * Initialize the Rally library.
   *
   * @param {String} schemaNamespace
   *        The namespace for this study. Must match the server-side schema.
   * @param {Object} key
   *        The JSON Web Key (JWK) used to encrypt the outgoing data.
   *        See the RFC 7517 https://tools.ietf.org/html/rfc7517
   *        for additional information. For example:
   *
   *        {
   *          "kty":"EC",
   *          "crv":"P-256",
   *          "x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
   *          "y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
   *          "kid":"Public key used in JWS spec Appendix A.3 example"
   *        }
   * @param {Boolean} enableDevMode
   *        Whether or not to initialize Rally.js in developer mode.
   *        In this mode we ignore problems when communicating with
   *        core add-on.
   *
   * @param {Function} stateChangeCallback
   *        A function to call when the study is paused or running.
   *        Takes a single parameter, `message`, which is the {String}
   *        received regarding the current study state ("paused" or "running".)
   */
  constructor(schemaNamespace: string, key: { kid: string }, enableDevMode: boolean, stateChangeCallback: (arg0: string) => void) {
    console.debug("Rally.initialize");

    this._validateEncryptionKey(key);

    if (!stateChangeCallback) {
      throw new Error("Rally.initialize - Initialization failed, stateChangeCallback is required.")
    }

    if (typeof stateChangeCallback !== "function") {
      throw new Error("Rally.initialize - Initialization failed, stateChangeCallback is not a function.")
    }

    this._namespace = schemaNamespace;
    this._keyId = key.kid;
    this._key = key;
    this._enableDevMode = Boolean(enableDevMode);
    this._rallyId = null;

    let hasRally = this._checkRallyCore().then(() => {
      console.debug("Rally.initialize - Found the Core Add-on.");
      return true;
    }).catch(async () => {
      // We did not find the Rally Core Add-on. But maybe we
      // are in developer mode. Do not trigger the sign-up flow
      // if that's the case.
      if (this._enableDevMode) {
        console.warn("Rally.initialize - Executing in developer mode.");
        return true;
      }

      // The Core Add-on was not found and we're not in developer
      // mode.
      await browser.tabs.create({ url: SIGNUP_URL });
      return false;
    });

    if (!hasRally) {
      throw new Error("Rally.initialize - Initialization failed.");
    }

    // Listen for incoming messages from the Core addon.
    browser.runtime.onMessageExternal.addListener(
      (m, s) => this._handleExternalMessage(m, s));


    // Set the initial state to running, and register callback for future changes.
    this._state = runStates.RUNNING;
    this._stateChangeCallback = stateChangeCallback;

    // We went through the whole init process, it's now safe
    // to use the Rally public APIs.
    this._initialized = true;
  }

  /**
   * Check if the Core addon is installed.
   *
   * @returns {Promise} resolved if the core addon was found and
   *          communication was successful, rejected otherwise.
   */
  async _checkRallyCore(): Promise<void> {
    try {
      const msg = {
        type: "core-check",
        data: {}
      }

      let response: CoreCheckResponse =
        await browser.runtime.sendMessage(CORE_ADDON_ID, msg, {});

      if (response.type == "core-check-response") {
        if (response.data.rallyId !== null) {
          this._rallyId = response.data.rallyId;
        } else {
          throw new Error(`Rally._checkRallyCore - core addon present, but not enrolled in Rally`);
        }
      } else {
        throw new Error(`Rally._checkRallyCore - unexpected response returned ${response}`);
      }

    } catch (ex) {
      throw new Error(`Rally._checkRallyCore - core addon check failed with: ${ex}`);
    }
  }

  /**
   * Pause the current study.
   */
  _pause() {
    if (this._state !== runStates.PAUSED) {
      this._stateChangeCallback("pause");
      this._state = runStates.PAUSED;
    }
  }

  /**
   * Resume the current study, if paused.
   */
  _resume() {
    if (this._state !== runStates.RUNNING) {
      this._stateChangeCallback("resume");
      this._state = runStates.RUNNING;
    }
  }
  private _stateChangeCallback(arg0: string) {
    throw new Error("Method not implemented.");
  }

  /**
   * Handles messages coming in from external addons.
   *
   * @param {Object} message
   *        The payload of the message.
   * @param {runtime.MessageSender} sender
   *        An object containing informations about who sent
   *        the message.
   * @returns {Promise} The response to the received message.
   *          It can be resolved with a value that is sent to the
   *          `sender`.
   */
  _handleExternalMessage(message: { type: string; }, sender: Runtime.MessageSender) {
    // We only expect messages coming from the core addon.
    if (sender.id != CORE_ADDON_ID) {
      return Promise.reject(
        new Error(`Rally._handleExternalMessage - unexpected sender ${sender.id}`));
    }

    switch (message.type) {
      case "pause":
        this._pause();
        break;
      case "resume":
        this._resume();
        break;
      case "uninstall":
        return browser.management.uninstallSelf({ showConfirmDialog: false });
      default:
        return Promise.reject(
          new Error(`Rally._handleExternalMessage - unexpected message type ${message.type}`));
    }
  }

  /**
   * Validate the provided encryption keys.
   *
   * @param {Object} key
   *        The JSON Web Key (JWK) used to encrypt the outgoing data.
   *        See the RFC 7517 https://tools.ietf.org/html/rfc7517
   *        for additional information. For example:
   *
   *        {
   *          "kty":"EC",
   *          "crv":"P-256",
   *          "x":"f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
   *          "y":"x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
   *          "kid":"Public key used in JWS spec Appendix A.3 example"
   *        }
   *
   * @throws {Error} if either the key id or the JWK key object are
   *         invalid.
   */
  _validateEncryptionKey(key: { kid: string }) {
    if (typeof key !== "object") {
      throw new Error("Rally._validateEncryptionKey - Invalid encryption key" + key);
    }

    if (!("kid" in key && typeof key.kid === "string")) {
      throw new Error("Rally._validateEncryptionKey - Missing or invalid encryption key ID in key" + key);
    }
  }

  /**
   * Submit an encrypted ping through the Rally Core addon.
   *
   * @param {String} payloadType
   *        The type of the encrypted payload. This will define the
   *        `schemaName` of the ping.
   * @param {Object} payload
   *        A JSON-serializable payload to be sent with the ping.
   */
  async sendPing(payloadType: string, payload: object) {
    if (!this._initialized) {
      console.error("Rally.sendPing - Not initialzed, call `initialize()`");
      return;
    }

    // When in developer mode, dump the payload to the console.
    if (this._enableDevMode) {
      console.log(
        `Rally.sendPing - Developer mode. ${payloadType} will not be submitted`,
        payload
      );
      return;
    }

    // When paused, not send data.
    if (this._state === runStates.PAUSED) {
      console.debug("Rally.sendPing - Study is currently paused, not sending data");
      return;
    }

    // Wrap everything in a try block, as we don't really want
    // data collection to be the culprit of a bug hindering user
    // experience.
    try {
      // This function may be mistakenly called while init has not
      // finished. Let's be safe and check for key validity again.
      this._validateEncryptionKey(this._key);

      const msg = {
        type: "telemetry-ping",
        data: {
          payloadType: payloadType,
          payload: payload,
          namespace: this._namespace,
          keyId: this._keyId,
          key: this._key
        }
      }
      await browser.runtime.sendMessage(CORE_ADDON_ID, msg, {});
    } catch (ex) {
      console.error(`Rally.sendPing - error while sending ${payloadType}`, ex);
    }
  }

  /**
   * Public getter to return the Rally ID.
   *
   * @returns {String} rallyId
   *        A JSON-serializable payload to be sent with the ping.
   */
  get rallyId(): string | null {
    return this._rallyId;
  }
}