/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { v4 as uuidv4 } from "uuid";
import { browser, Runtime } from "webextension-polyfill-ts";

export enum runStates {
  RUNNING,
  PAUSED,
}

export class Rally {
  private _enableDevMode: boolean;
  private _rallyId: string | null;
  private _state: runStates;

  /**
   * Initialize the Rally library.
   *
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
  constructor(enableDevMode: boolean, stateChangeCallback: (runState: runStates) => void) {
    console.debug("Rally.initialize");

    if (!stateChangeCallback) {
      throw new Error("Rally.initialize - Initialization failed, stateChangeCallback is required.")
    }

    if (typeof stateChangeCallback !== "function") {
      throw new Error("Rally.initialize - Initialization failed, stateChangeCallback is not a function.")
    }

    this._enableDevMode = Boolean(enableDevMode);

    this._rallyId = null;

    // Set the initial state to paused, and register callback for future changes.
    this._state = runStates.PAUSED;
    this._stateChangeCallback = stateChangeCallback;

    browser.runtime.onMessageExternal.addListener(
      (m, s) => this._handleWebMessage(m, s));


    this._promptSignUp().catch(err => console.error(err));
  }

  async _promptSignUp() {
    // await browser.storage.local.set({ "signUpComplete": true });

    const alreadySignedUp = await browser.storage.local.get("signUpComplete");
    console.debug(alreadySignedUp);
    if ("signUpComplete" in alreadySignedUp) {
      console.debug("Already signed-up.");
      return;
    }

    const tabs = await browser.tabs.query({ url: "*://rally-web-spike.web.app/*" });
    // If there are any tabs with the Rally site loaded, focus the latest one.
    if (tabs.length > 0) {
      const tab: any = tabs.pop();
      browser.windows.update(tab.windowId, { focused: true });
      browser.tabs.update(tab.id, { highlighted: true, active: true });
    } else {
      // Otherwise, open the website.
      browser.tabs.create({ url: "https://rally-web-spike.web.app/" });
    }
  }

  /**
   * Pause the current study.
   */
  _pause() {
    if (this._state !== runStates.PAUSED) {
      this._state = runStates.PAUSED;
      this._stateChangeCallback(runStates.PAUSED);
    }
  }

  /**
   * Resume the current study, if paused.
   */
  _resume() {
    if (this._state !== runStates.RUNNING) {
      this._state = runStates.RUNNING;
      this._stateChangeCallback(runStates.RUNNING);
    }
  }

  private _stateChangeCallback(runState: runStates) {
    throw new Error("Method not implemented, must be provided by study.");
  }

  /**
   * Generate and cache the Rally ID.
   *
   * @returns {String} rallyId
   *        The Rally ID (if set).
   */
  async rallyId(): Promise<string | null> {
    if (this._rallyId) {
      return this._rallyId;
    } else {
      const result = await browser.storage.local.get("rallyId");
      if ("rallyId" in result) {
        this._rallyId = result.rallyId;
      } else {
        const uuid = uuidv4();
        await browser.storage.local.set({ "rallyId": uuid });
        this._rallyId = uuid;
      }
    }
    return this._rallyId;
  }

  /**
   * Handler for external messages coming from Rally services.
   */
  async _handleExternalMessage(message: { type: string; }, sender: string) {
    switch (message.type) {
      case "pause":
        this._pause();
        break;
      case "resume":
        this._resume();
        break;
      default:
        throw new Error(`Rally._handleExternalMessage - unexpected message type ${message.type}`);
    }
  }

  /**
 * Handles messages coming in from the external website.
 *
 * @param {Object} message
 *        The payload of the message.
 * @param {runtime.MessageSender} sender
 *        An object containing information about who sent
 *        the message.
 * @returns {Promise} The response to the received message.
 *          It can be resolved with a value that is sent to the
 *          `sender` or rejected in case of errors.
 */
  _handleWebMessage(message: any, sender: any) {
    console.log("Core - received web message", message, "from", sender);

    try {
      // Security check - only allow messages from our own site!
      let platformURL = new URL("https://rally-web-spike.web.app/");
      let senderURL = new URL(sender.url);
      if (platformURL.origin != senderURL.origin) {
        return Promise.reject(
          new Error(`Core - received message from unexpected URL ${sender.url}`));
      }
    } catch (ex) {
      return Promise.reject(
        new Error(`Core - cannot validate sender URL ${sender.url}`));
    }

    // ** IMPORTANT **
    //
    // The website should *NOT EVER* be trusted. Other addons could be
    // injecting content scripts there too, impersonating the website
    // and performing requests on its behalf.
    //
    // Do not ever add other features or messages here without thinking
    // thoroughly of the implications: can the message be used to leak
    // information out? Can it be used to mess with studies?

    switch (message.type) {
      case "web-check":
        // The `web-check` message should be safe: any installed addon with
        // the `management` privileges could check for the presence of the
        // core addon and expose that to the web. By exposing this ourselves
        // through content scripts enabled on our domain, we don't make things
        // worse.
        return Promise.resolve({
          type: "web-check-response",
          data: {}
        });
      case "complete-signup":
        // The `open-rally` message should be safe: it exclusively opens
        // the addon options page. It's a one-direction communication from the
        // page, as no data gets exfiltrated or no message is reported back.
        const signUpComplete = Boolean(this._completeSignUp(message.data));
        return Promise.resolve({ type: "complete-signup", data: { signUpComplete } });
      default:
        return Promise.reject(
          new Error(`Core._handleWebMessage - unexpected message type "${message.type}"`));
    }
  }

  async _completeSignUp(authToken: any) {
    const signUpStorage = await browser.storage.local.get("signUpComplete");
    if (!("signUpComplete" in signUpStorage)) {
      // Record sign-up complete.
      await browser.storage.local.set({ "signUpComplete": true });

      // Store the auth token.
      // TODO we should let Firebase handle it for us.
      await browser.storage.local.set({ authToken });
    } else {
      console.warn("Sign-up is already complete.")
    }

    return true;
  }
}