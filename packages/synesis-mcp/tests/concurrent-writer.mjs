import { parentPort, workerData } from 'node:worker_threads';
import { Library } from '../dist/library.js';
const library = new Library(workerData.library);
parentPort.once('message', () => {
  try {
    for (let iteration = 0; iteration < 150; iteration++) {
      library.delete({ pack: workerData.pack.id, version: workerData.pack.version });
      library.import(workerData.other);
      library.delete({ pack: workerData.other.id, version: workerData.other.version });
      library.import(workerData.pack);
    }
    parentPort.postMessage({ done: true });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
  finally { library.close(); parentPort.close(); }
});
parentPort.postMessage({ ready: true });
