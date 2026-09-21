import { useEffect, useRef, useState } from "react";
import { isSidebarPresence } from "./page-bridge";

export function useSidePanelToggle(onError: (message: string) => void) {
  const ports = useRef(new Set<chrome.runtime.Port>());
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const pending = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const finish = () => { clearTimeout(timer.current); pending.current = false; setBusy(false); };
  useEffect(() => {
    let disposed = false;
    const connect = (port: chrome.runtime.Port) => {
      if (!isSidebarPresence(port)) return;
      ports.current.add(port);
      setOpen(true);
      finish();
      port.onMessage.addListener(message => {
        if (message?.type === "close-sidepanel-error") {
          finish();
          errorRef.current(message.error);
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        ports.current.delete(port);
        if (!disposed) { setOpen(ports.current.size > 0); finish(); }
      });
    };
    chrome.runtime.onConnect.addListener(connect);
    return () => {
      disposed = true;
      clearTimeout(timer.current);
      chrome.runtime.onConnect.removeListener(connect);
      for (const port of ports.current) port.disconnect();
      ports.current.clear();
    };
  }, []);
  const toggle = () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    timer.current = setTimeout(finish, 2000);
    try {
      const port = ports.current.values().next().value;
      if (port) port.postMessage({ type: "close-sidepanel" });
      else void chrome.runtime.sendMessage({ type: "open-sidepanel" }).then(response => {
        if (!response?.ok) throw Error(response?.error || "侧边栏打开失败，请刷新网页后重试。");
      }).catch(error => { finish(); errorRef.current(String(error)); });
    } catch (error) { finish(); errorRef.current(String(error)); }
  };
  return { open, busy, toggle };
}
