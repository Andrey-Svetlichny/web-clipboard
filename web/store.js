// Device keys in IndexedDB. Written only when "stay signed in" is chosen: on someone
// else's machine everything stays in the tab's memory.

const DB_NAME = 'web-clipboard';
const DB_STORE = 'kv';
const DB_KEY = 'device';

// One connection for the life of the page, opened on first use.
let connection = null;

function openDb() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the schema, or the browser closing the connection under
        // us: let it go, and the next call opens a fresh one.
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        db.onclose = () => { connection = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
    // A failed open is not cached either.
    connection.catch(() => { connection = null; });
  }
  return connection;
}

// Resolves once the transaction has committed, not merely when its request succeeded:
// a write is not on disk until then.
async function tx(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, mode);
    const request = run(transaction.objectStore(DB_STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
  });
}

export async function loadDevice() {
  try {
    return await tx('readonly', (store) => store.get(DB_KEY));
  } catch {
    return null;
  }
}

// Whether to write at all is the caller's decision: what arrives here is the finished
// record. Errors are not swallowed, since the caller has something to tell the user.
export async function saveDevice({ roomKey, encKey, seqs, deviceName, autoRefresh, deviceId }) {
  await tx('readwrite',
    (store) => store.put({ roomKey, encKey, seqs, deviceName, autoRefresh, deviceId }, DB_KEY));
}

export async function wipeDevice() {
  try {
    await tx('readwrite', (store) => store.delete(DB_KEY));
  } catch { /* nothing worth reporting; the page reloads either way */ }
}
