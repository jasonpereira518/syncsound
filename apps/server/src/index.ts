import { createServer } from 'node:http';
import { SERVER_PORT_DEFAULT } from '@syncsound/protocol';

const port = Number(process.env.PORT ?? SERVER_PORT_DEFAULT);
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}).listen(port, () => console.log(`[server] listening on :${port}`));
