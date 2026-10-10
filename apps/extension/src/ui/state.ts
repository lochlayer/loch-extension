// The snapshot, kept current. The pages never compute state: they show what the worker says.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { Snapshot } from "../shared/view.js";
import type { Api } from "./api.js";

/** How often an open page asks the worker to sync. */
const SYNC_EVERY_MS = 20_000;

export function useSnapshot(api: Api): { snapshot: Snapshot | null; refresh: () => void; failed: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(() => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    void api.call<Snapshot>({ loch: "ui", type: "state" }).then((reply) => {
      running.current = false;
      if (reply.ok) {
        setSnapshot(reply.value);
        setFailed(false);
      } else setFailed(true);
      if (again.current) {
        again.current = false;
        refresh();
      }
    });
  }, [api]);

  useEffect(() => {
    refresh();
    const stop = api.subscribe(refresh);
    void api.call({ loch: "ui", type: "sync" });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void api.call({ loch: "ui", type: "sync" });
    }, SYNC_EVERY_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [api, refresh]);

  return { snapshot, refresh, failed };
}

export interface Toast {
  id: number;
  text: string;
  kind: "done" | "caution" | "plain";
}

export function useToasts(): [Toast[], (text: string, kind?: Toast["kind"]) => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, kind: Toast["kind"] = "plain") => {
    const id = next.current++;
    setToasts((list) => [...list.slice(-1), { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), 5200);
  }, []);
  return [toasts, push];
}
