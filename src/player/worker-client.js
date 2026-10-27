// Requests to a worker and their answers: { id, result } or { id, error } (see whisper-worker.js); any other
// message, such as the download progress, goes to `onMessage`. The worker is started with the first request.
// A worker that has crashed is thrown away, so the next request gets a new one and does not wait for a dead one.

export function createWorkerClient(createWorker, onMessage) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function rejectAll(reason) {
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
  }

  function start() {
    const created = createWorker();
    created.onmessage = ({ data }) => {
      if (!("id" in data)) return onMessage(data);
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve(data.result);
    };
    created.onerror = (event) => {
      created.terminate();
      if (worker === created) worker = null;
      rejectAll(event.message || "ошибка воркера");
    };
    return created;
  }

  return {
    ask(message, transfer = []) {
      worker ??= start();
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ ...message, id }, transfer);
      });
    },

    close() {
      worker?.terminate();
      worker = null;
      rejectAll("распознавание остановлено");
    },
  };
}
