import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from './app.mjs';

const API_TOKEN = 'test-api-token';
const auth = { Authorization: `Bearer ${API_TOKEN}` };

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function decode(token) {
  const [header, payload, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url')),
    claims: JSON.parse(Buffer.from(payload, 'base64url')),
    signed: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, 'base64url'),
  };
}

async function publicKey(base, keysPath, kid) {
  const fileName = createHash('sha256').update(kid).digest('hex');
  const response = await fetch(`${base}${keysPath}/${fileName}.pem`);
  assert.equal(response.status, 200);
  return response.text();
}

describe('reference app', () => {
  let app, appUrl, appServer, prosodyServer, recordingsDir;
  const controlCalls = [];

  before(async () => {
    const prosody = await listen((req, res) => {
      controlCalls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      res.end();
    });
    prosodyServer = prosody.server;
    recordingsDir = mkdtempSync(join(tmpdir(), 'meet-app-test-'));
    app = createApp({
      publicUrl: 'https://meet.example.org',
      appId: 'example-app',
      apiToken: API_TOKEN,
      controlUrl: prosody.url,
      mucDomain: 'muc.meet.jitsi',
      tenant: 'acme',
      recordingsDir,
    });
    ({ server: appServer, url: appUrl } = await listen(app.handle));
  });

  after(() => {
    appServer.close();
    prosodyServer.close();
    rmSync(recordingsDir, { recursive: true, force: true });
  });

  const joinUrl = async (query) => {
    const response = await fetch(`${appUrl}/join?${new URLSearchParams(query)}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    return new URL(response.headers.get('location'));
  };

  const roomGate = (name) => fetch(`${appUrl}/meet/api/conference`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name, start_time: '2026-10-05T09:00:00.000Z', mail_owner: 'owner@meet.jitsi' }),
  });

  it('redirects to the room with a join token signed by the served join key', async () => {
    const location = await joinUrl({ room: 'room-1', name: 'Alex', id: 'user-1', moderator: '1' });
    assert.equal(location.origin + location.pathname, 'https://meet.example.org/acme/room-1');

    const token = decode(location.searchParams.get('jwt'));
    const pem = await publicKey(appUrl, '/meet/keys', token.header.kid);
    assert.ok(verify('sha256', token.signed, pem, token.signature));
    assert.equal(token.header.alg, 'RS256');
    assert.equal(token.claims.iss, 'example-app');
    assert.equal(token.claims.sub, 'acme');
    assert.equal(token.claims.room, 'room-1');
    assert.deepEqual(
      { id: token.claims.context.user.id, moderator: token.claims.context.user.moderator },
      { id: 'user-1', moderator: true },
    );
  });

  it('approves rooms it issued tokens for and refuses others with a message', async () => {
    await joinUrl({ room: 'room-2', id: 'user-1' });

    const approved = await roomGate('[acme]room-2');
    assert.equal(approved.status, 200);
    const record = await approved.json();
    assert.equal(record.name, '[acme]room-2');
    assert.ok(record.duration > 0);

    const again = await (await roomGate('[acme]room-2')).json();
    assert.equal(again.id, record.id);

    const fetched = await fetch(`${appUrl}/meet/api/conference/${record.id}`, { headers: auth });
    assert.deepEqual(await fetched.json(), record);

    const deleted = await fetch(`${appUrl}/meet/api/conference/${record.id}`, { method: 'DELETE', headers: auth });
    assert.equal(deleted.status, 200);

    const refused = await roomGate('[acme]not-issued');
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).message, /not scheduled/);
  });

  it('accepts webhooks only with the API token', async () => {
    const body = JSON.stringify({ event_name: 'muc-occupant-joined', occupant: { id: 'user-1' } });
    const post = (headers) => fetch(`${appUrl}/meet/api/events/occupant/joined`, { method: 'POST', headers, body });

    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(auth)).status, 200);

    const events = await (await fetch(`${appUrl}/events`)).json();
    assert.equal(events.at(-1).name, 'events/occupant/joined');
    assert.equal(events.at(-1).payload.occupant.id, 'user-1');
  });

  it('stores an uploaded recording under its key', async () => {
    const response = await fetch(`${appUrl}/meet/api/recordings/finished?key=1791100990_acme_room&meeting_url=x`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'video/mp4' },
      body: 'video',
    });
    assert.equal(response.status, 200);
    assert.equal(readFileSync(join(recordingsDir, '1791100990_acme_room.mp4'), 'utf8'), 'video');

    const unsafe = await fetch(`${appUrl}/meet/api/recordings/finished?key=../x`, { method: 'PUT', headers: auth });
    assert.equal(unsafe.status, 400);
  });

  it('calls kick-user with a token signed by the control key, not the join key', async () => {
    const response = await fetch(`${appUrl}/control/kick-user?room=room-1&user=user-2`, { method: 'POST' });
    assert.equal(response.status, 200);

    const call = controlCalls.at(-1);
    const url = new URL(call.url, 'http://prosody');
    assert.equal(call.method, 'POST');
    assert.equal(url.pathname, '/kick-user');
    assert.equal(url.searchParams.get('conference'), '[acme]room-1@muc.meet.jitsi');
    assert.equal(url.searchParams.get('user'), 'user-2');

    const token = decode(call.authorization.slice('Bearer '.length));
    const controlPem = await publicKey(appUrl, '/meet/control-keys', token.header.kid);
    assert.ok(verify('sha256', token.signed, controlPem, token.signature));
    assert.notEqual(token.header.kid, app.joinKeys.kid);
    assert.equal((await fetch(`${appUrl}/meet/keys/${app.controlKeys.fileName}`)).status, 404);
  });
});
