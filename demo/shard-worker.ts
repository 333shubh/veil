// Browser entry for a shard of meters.
import { host, type Request } from './shard.ts';

const handle = host();
self.onmessage = (e: MessageEvent<Request>) => self.postMessage(handle(e.data));
