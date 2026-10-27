import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerClient } from "../src/player/worker-client.js";

// Workers made so far; each answers { id, result: "echo <type>" } when told to by `reply`.
function useWorkers() {
  const made = [];
  const createWorker = () => {
    const worker = {
      terminated: false,
      postMessage: (message) => worker.sent.push(message),
      terminate: () => { worker.terminated = true; },
      sent: [],
    };
    made.push(worker);
    return worker;
  };
  return { made, createWorker };
}

test("an answer goes to its request, the other messages to the listener", async () => {
  const { made, createWorker } = useWorkers();
  const heard = [];
  const client = createWorkerClient(createWorker, (message) => heard.push(message));
  const result = client.ask({ type: "load" });
  made[0].onmessage({ data: { type: "progress", loaded: 1, total: 2 } });
  made[0].onmessage({ data: { id: made[0].sent[0].id, result: "done" } });
  assert.equal(await result, "done");
  assert.deepEqual(heard, [{ type: "progress", loaded: 1, total: 2 }]);
});

test("an error answer rejects only its request", async () => {
  const { made, createWorker } = useWorkers();
  const client = createWorkerClient(createWorker, () => {});
  const failed = client.ask({ type: "transcribe" });
  made[0].onmessage({ data: { id: made[0].sent[0].id, error: "out of memory" } });
  await assert.rejects(failed, /out of memory/);
});

test("a crashed worker is replaced for the next request, which is not left waiting for the dead one", async () => {
  const { made, createWorker } = useWorkers();
  const client = createWorkerClient(createWorker, () => {});
  const lost = client.ask({ type: "transcribe" });
  made[0].onerror({ message: "device lost" });
  await assert.rejects(lost, /device lost/);
  assert.equal(made[0].terminated, true);

  const next = client.ask({ type: "load" });
  assert.equal(made.length, 2);
  made[1].onmessage({ data: { id: made[1].sent[0].id, result: "ok" } });
  assert.equal(await next, "ok");
});

test("close stops the worker and rejects what waits for it", async () => {
  const { made, createWorker } = useWorkers();
  const client = createWorkerClient(createWorker, () => {});
  const waiting = client.ask({ type: "transcribe" });
  client.close();
  await assert.rejects(waiting, /остановлено/);
  assert.equal(made[0].terminated, true);
});
