import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.mjs';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
  return value;
}

const app = createApp({
  publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
  appId: required('JWT_APP_ID'),
  apiToken: required('MEET_APP_API_TOKEN'),
  controlUrl: (process.env.MEET_CONTROL_URL ?? 'http://127.0.0.1:5280').replace(/\/$/, ''),
  mucDomain: process.env.XMPP_MUC_DOMAIN ?? 'muc.meet.jitsi',
  tenant: process.env.APP_TENANT ?? 'acme',
  recordingsDir: process.env.APP_RECORDINGS_DIR ?? join(tmpdir(), 'meet-recordings'),
  log: (line) => console.log(line),
});

const port = Number(process.env.APP_PORT ?? 3000);
createServer(app.handle).listen(port, () => {
  console.log(`reference app listening on :${port}, join keys kid ${app.joinKeys.kid}, control keys kid ${app.controlKeys.kid}`);
});
