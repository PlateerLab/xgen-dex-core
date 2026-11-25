import type { PendingStorage } from '@dex/protocol';

// Inline pasted images can exceed the localStorage quota. Keep them in IndexedDB.
let db: Promise<IDBDatabase> | undefined;
function database() {
  if (!db) db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('xgen-composer-attachments', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { db = undefined; reject(request.error); };
  });
  return db;
}

export const attachmentStorage: PendingStorage = {
  async keys(prefix) {
    const db = await database();
    return new Promise<string[]>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => resolve(request.result.filter((key): key is string => typeof key === 'string'));
      request.onerror = () => reject(request.error);
    });
  },
  async read(key) {
    const db = await database();
    return new Promise<string | null>((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  },
  async write(key, value) {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      const store = tx.objectStore('drafts');
      if (value === null) store.delete(key); else store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  },
};
