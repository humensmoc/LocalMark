import type { Entry, Library } from "./model";

const META = "library:meta";
const ENTRY = "library:entry:";
const URL_KEY = "library:url:";
type LibraryMeta = Omit<Library, "entries">;
const entryKeys = () => IDBKeyRange.bound(ENTRY, `${ENTRY}\uffff`);
const urlKeys = () => IDBKeyRange.bound(URL_KEY, `${URL_KEY}\uffff`);
let pending: Promise<IDBDatabase> | undefined;
function db() {
  return (pending ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("local-web-clipper", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
let normalization: Promise<void> | undefined;
function ensureNormalized(): Promise<void> {
  return normalization ??= (async () => {
    const d = await db();
    const tx = d.transaction("kv", "readwrite");
    const store = tx.objectStore("kv");
    const done = complete(tx);
    const existing = await requestValue<LibraryMeta | undefined>(store.get(META));
    if (!existing) {
      const legacy = await requestValue<Library | undefined>(store.get("library"));
      if (legacy) {
        const { entries, ...meta } = legacy;
        store.put(meta, META);
        for (const [id, entry] of Object.entries(entries)) {
          store.put(entry, ENTRY + id);
          store.put(id, URL_KEY + entry.page.url);
        }
        store.delete("library");
      }
    }
    await done;
  })().catch(error => {
    normalization = undefined;
    throw error;
  });
}
async function rawGet<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return requestValue<T | undefined>(d.transaction("kv").objectStore("kv").get(key));
}
export async function getLibraryMeta(): Promise<LibraryMeta | undefined> {
  await ensureNormalized();
  return rawGet<LibraryMeta>(META);
}
export async function getLibraryEntry(id: string): Promise<Entry | undefined> {
  await ensureNormalized();
  return rawGet<Entry>(ENTRY + id);
}
export async function getLibraryEntryIdForUrl(url: string): Promise<string | undefined> {
  await ensureNormalized();
  return rawGet<string>(URL_KEY + url);
}
export async function get<T>(key: string): Promise<T | undefined> {
  if (key !== "library") return rawGet<T>(key);
  await ensureNormalized();
  const d = await db();
  const tx = d.transaction("kv");
  const store = tx.objectStore("kv");
  const meta = await requestValue<LibraryMeta | undefined>(store.get(META));
  if (!meta) return undefined;
  const [keys, values] = await Promise.all([
    requestValue<IDBValidKey[]>(store.getAllKeys(entryKeys())),
    requestValue<Entry[]>(store.getAll(entryKeys())),
  ]);
  const entries = Object.fromEntries(keys.map((key, index) => [String(key).slice(ENTRY.length), values[index]]));
  return { ...meta, entries } as T;
}
export async function saveLibraryEntry(id: string, entry: Entry, patch: Partial<LibraryMeta>) {
  await ensureNormalized();
  const d = await db();
  const tx = d.transaction("kv", "readwrite");
  const store = tx.objectStore("kv");
  const done = complete(tx);
  const meta = await requestValue<LibraryMeta | undefined>(store.get(META));
  if (!meta) throw Error("浏览器资料尚未初始化");
  store.put({ ...meta, ...patch }, META);
  store.put(entry, ENTRY + id);
  store.put(id, URL_KEY + entry.page.url);
  await done;
}
export async function set(key: string, value: unknown) {
  const d = await db();
  if (key !== "library") {
    const tx = d.transaction("kv", "readwrite");
    const done = complete(tx);
    tx.objectStore("kv").put(value, key);
    return done;
  }
  await ensureNormalized();
  const lib = value as Library;
  const { entries, ...meta } = lib;
  const tx = d.transaction("kv", "readwrite");
  const store = tx.objectStore("kv");
  const done = complete(tx);
  const [keys, oldUrls] = await Promise.all([
    requestValue<IDBValidKey[]>(store.getAllKeys(entryKeys())),
    requestValue<IDBValidKey[]>(store.getAllKeys(urlKeys())),
  ]);
  for (const key of keys) if (!(String(key).slice(ENTRY.length) in entries)) store.delete(key);
  for (const key of oldUrls) store.delete(key);
  for (const [id, entry] of Object.entries(entries)) {
    store.put(entry, ENTRY + id);
    store.put(id, URL_KEY + entry.page.url);
  }
  store.put(meta, META);
  store.delete("library");
  await done;
}
