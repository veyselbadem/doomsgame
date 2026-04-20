import type { ServerResponse } from 'http';

const clients = new Set<ServerResponse & { write: (chunk: string) => void }>();

function reqOnClose(res: ServerResponse, cb: () => void) {
  res.on('close', cb);
  res.on('finish', cb);
}

export function addClient(res: ServerResponse) {
  clients.add(res);
  reqOnClose(res, () => {
    clients.delete(res);
  });
}

export function send(message: string | unknown) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  const time = new Date().toISOString();
  const data = `data: ${JSON.stringify({ time, message: payload })}\n\n`;

  for (const res of Array.from(clients)) {
    try {
      res.write(data);
    } catch {
      // ignore write errors — client will be cleaned up on close
    }
  }
}

export default { addClient, send };
