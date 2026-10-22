// How the pages talk to the service worker. The pages hold no state of their own beyond what is
// on screen: they ask for a snapshot, send requests, and are told when the snapshot changed.

import { isRecord } from "../shared/guards.js";
import { STATE_CHANGED, type UiReply, type UiRequest } from "../shared/view.js";

/** What a form has in it, kept while the popup is closed (it closes whenever the wallet opens). */
export interface Draft {
  kind: "dive" | "send" | "surface" | "move";
  to: string;
  amount: string;
}

export interface Api {
  /** True in the 380 x 600 popup, false in the expanded view. */
  popup: boolean;
  call<T = unknown>(request: UiRequest): Promise<UiReply<T>>;
  /** Calls `listener` whenever the snapshot may have changed. Returns a function that stops it. */
  subscribe(listener: () => void): () => void;
  copy(text: string): Promise<boolean>;
  /** Saves `text` as a file through the browser's own download. False if the browser would not. */
  save(filename: string, text: string, type: string): boolean;
  openExpanded(): void;
  /** Asks the browser for permission to talk to these origins. Must be called from a click. */
  requestAccess(origins: string[]): Promise<boolean>;
  draft(): Promise<Draft | null>;
  setDraft(draft: Draft | null): Promise<void>;
  /** The address of a file inside the extension package (licence texts). */
  packaged(path: string): string;
  now(): number;
}

const DRAFT_KEY = "ui:draft";

export function extensionApi(popup: boolean): Api {
  return {
    popup,
    async call<T>(request: UiRequest) {
      try {
        const reply = (await chrome.runtime.sendMessage(request)) as UiReply<T> | undefined;
        return reply ?? { ok: false, error: { code: "no-answer", message: "the extension did not answer" } };
      } catch {
        return { ok: false, error: { code: "no-answer", message: "the extension did not answer" } };
      }
    },
    subscribe(listener) {
      const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
        if (sender.id === chrome.runtime.id && sender.tab === undefined && isRecord(message) && message.loch === "worker" && message.type === STATE_CHANGED) listener();
        return false;
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => chrome.runtime.onMessage.removeListener(onMessage);
    },
    async copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    save(filename, text, type) {
      try {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const link = Object.assign(document.createElement("a"), { href: url, download: filename });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return true;
      } catch {
        return false;
      }
    },
    openExpanded() {
      void chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
    },
    async requestAccess(origins) {
      const patterns = origins.map((origin) => `${origin}/*`);
      try {
        if (await chrome.permissions.contains({ origins: patterns })) return true;
        return await chrome.permissions.request({ origins: patterns });
      } catch {
        return false;
      }
    },
    async draft() {
      const stored = await chrome.storage.session.get(DRAFT_KEY);
      const draft = stored[DRAFT_KEY] as Draft | undefined;
      return draft ?? null;
    },
    async setDraft(draft) {
      if (draft) await chrome.storage.session.set({ [DRAFT_KEY]: draft });
      else await chrome.storage.session.remove(DRAFT_KEY);
    },
    packaged: (path) => chrome.runtime.getURL(path),
    now: () => Date.now(),
  };
}
