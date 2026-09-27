// Node entry for a shard of meters, used by the soak run.
import { parentPort } from 'node:worker_threads';
import { host, type Request } from './shard.ts';

const handle = host();
parentPort!.on('message', (req: Request) => parentPort!.postMessage(handle(req)));
