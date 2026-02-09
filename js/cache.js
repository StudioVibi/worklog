// IndexedDB cache for Worklog logs
const LogCache = {
  dbName: 'worklog-cache',
  dbVersion: 1,
  storeName: 'logs',
  dbPromise: null,

  isSupported() {
    return typeof window !== 'undefined' && 'indexedDB' in window;
  },

  async open() {
    if (!this.isSupported()) return null;
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'path' });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };

      request.onerror = () => {
        reject(request.error || new Error('Failed to open IndexedDB cache'));
      };

      request.onblocked = () => {
        reject(new Error('IndexedDB cache open blocked by another tab'));
      };
    });

    return this.dbPromise;
  },

  waitForTransaction(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  },

  async getAllLogs() {
    const db = await this.open();
    if (!db) return [];

    return await new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(Array.isArray(request.result) ? request.result : []);
      };
      request.onerror = () => {
        reject(request.error || new Error('Failed to read cached logs'));
      };
      tx.onabort = () => {
        reject(tx.error || new Error('IndexedDB transaction aborted'));
      };
    });
  },

  sanitizeLogs(logs) {
    return (logs || [])
      .filter(log => log && typeof log.path === 'string' && log.path.length > 0)
      .map(log => ({
        path: log.path,
        text: String(log.text || '')
      }));
  },

  async putLogs(logs) {
    const items = this.sanitizeLogs(logs);
    if (items.length === 0) return;

    const db = await this.open();
    if (!db) return;

    const tx = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);
    for (const item of items) {
      store.put(item);
    }
    await this.waitForTransaction(tx);
  },

  async replaceAllLogs(logs) {
    const items = this.sanitizeLogs(logs);
    const db = await this.open();
    if (!db) return;

    const tx = db.transaction(this.storeName, 'readwrite');
    const store = tx.objectStore(this.storeName);
    store.clear();
    for (const item of items) {
      store.put(item);
    }
    await this.waitForTransaction(tx);
  },

  async clear() {
    await this.replaceAllLogs([]);
  }
};
