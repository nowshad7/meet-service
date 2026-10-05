import { createHash, generateKeyPairSync, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const JOIN_TOKEN_TTL_SECONDS = 4 * 60 * 60;
const CONTROL_TOKEN_TTL_SECONDS = 60;
const ROOM_DURATION_SECONDS = 4 * 60 * 60;
const KEPT_EVENTS = 200;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const base64url = (value) => Buffer.from(value).toString('base64url');
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function createKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const kid = sha256(publicKeyPem).slice(0, 16);
  return { kid, privateKey, publicKeyPem, fileName: `${sha256(kid)}.pem` };
}

export function signJwt(claims, keyPair) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyPair.kid }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), keyPair.privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

export function joinClaims({ appId, tenant, room, user, privacy = false, now = nowSeconds() }) {
  const claims = {
    iss: appId,
    aud: 'jitsi',
    sub: tenant,
    room,
    nbf: now - 10,
    exp: now + JOIN_TOKEN_TTL_SECONDS,
    context: {
      user: {
        id: user.id,
        name: user.name,
        moderator: user.moderator,
        affiliation: user.moderator ? 'owner' : 'member',
        lobby_bypass: true,
      },
      features: {
        recording: user.moderator,
        'screen-sharing': true,
        transcription: false,
        livestreaming: false,
        'outbound-call': false,
      },
    },
  };
  if (privacy) {
    claims.context.room = { privacy: true };
  }
  return claims;
}

export function controlClaims({ appId, now = nowSeconds() }) {
  return { iss: appId, aud: 'jitsi', sub: '*', room: '*', exp: now + CONTROL_TOKEN_TTL_SECONDS };
}

export function roomJid(tenant, room, mucDomain) {
  return `[${tenant}]${room}@${mucDomain}`;
}

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain' : 'application/json', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function homePage(room) {
  const safeRoom = escapeHtml(room);
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>meet-service reference app</title>
<style>body{font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}
label{display:block;margin:.75rem 0}input{font:inherit;padding:.25rem}</style>
<h1>meet-service reference app</h1>
<p>Signs a join token for room <code>${safeRoom}</code> and sends you to the meeting.</p>
<form action="/join">
<input type="hidden" name="room" value="${safeRoom}">
<label>Name <input name="name" value="Host" required></label>
<label>User id <input name="id" value="user-1" required></label>
<label><input type="checkbox" name="moderator" value="1" checked> Moderator</label>
<label><input type="checkbox" name="privacy" value="1"> Privacy mode</label>
<button>Join</button>
</form>
<p>Open this page in a second browser with another user id to join as a participant.
Received webhooks: <a href="/events">/events</a>.</p>
`;
}

export function createApp(config) {
  const joinKeys = config.joinKeys ?? createKeyPair();
  const controlKeys = config.controlKeys ?? createKeyPair();
  const defaultRoom = config.defaultRoom ?? randomUUID();
  const issuedRooms = new Set();
  const conferences = new Map();
  const events = [];

  const requireBearer = (req) => {
    const header = req.headers.authorization ?? '';
    if (!sameSecret(header, `Bearer ${config.apiToken}`)) {
      throw new HttpError(401, { message: 'missing or wrong bearer token' });
    }
  };

  const recordEvent = (name, payload) => {
    events.push({ name, received_at: nowSeconds(), payload });
    events.splice(0, Math.max(0, events.length - KEPT_EVENTS));
    config.log?.(`event ${name} ${JSON.stringify(payload)}`);
  };

  const meetingUrl = (room, token) => `${config.publicUrl}/${config.tenant}/${room}?jwt=${token}`;

  const joinMeeting = (url) => {
    const room = (url.searchParams.get('room') || defaultRoom).toLowerCase();
    const user = {
      id: url.searchParams.get('id') || randomUUID(),
      name: url.searchParams.get('name') || 'Guest',
      moderator: url.searchParams.get('moderator') === '1',
    };
    const claims = joinClaims({
      appId: config.appId,
      tenant: config.tenant,
      room,
      user,
      privacy: url.searchParams.get('privacy') === '1',
    });
    issuedRooms.add(`[${config.tenant}]${room}`);
    return meetingUrl(room, signJwt(claims, joinKeys));
  };

  const approveRoom = (name, startTime, mailOwner) => {
    if (!issuedRooms.has(name)) {
      throw new HttpError(403, { message: 'This meeting is not scheduled in the app.' });
    }
    const existing = [...conferences.values()].find((record) => record.name === name);
    if (existing) {
      return existing;
    }
    const record = {
      id: randomUUID(),
      name,
      mail_owner: mailOwner,
      start_time: startTime,
      duration: ROOM_DURATION_SECONDS,
    };
    conferences.set(record.id, record);
    return record;
  };

  const control = async (action, url) => {
    const room = url.searchParams.get('room') ?? '';
    const query = new URLSearchParams({ conference: roomJid(config.tenant, room, config.mucDomain) });
    for (const name of ['user', 'ban']) {
      if (url.searchParams.has(name)) {
        query.set(name, url.searchParams.get(name));
      }
    }
    const token = signJwt(controlClaims({ appId: config.appId }), controlKeys);
    const response = await fetch(`${config.controlUrl}/${action}?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: { action, conference: query.get('conference'), status: response.status } };
  };

  const saveRecording = async (req, url) => {
    const key = url.searchParams.get('key') ?? '';
    if (!/^[\w.-]+$/.test(key)) {
      throw new HttpError(400, { message: 'invalid key' });
    }
    mkdirSync(config.recordingsDir, { recursive: true });
    await pipeline(req, createWriteStream(join(config.recordingsDir, `${key}.mp4`)));
    recordEvent('recordings/finished', { key, meeting_url: url.searchParams.get('meeting_url') });
  };

  const publicKey = (keyPair, fileName) => {
    if (fileName !== keyPair.fileName) {
      throw new HttpError(404, 'unknown key');
    }
    return keyPair.publicKeyPem;
  };

  const route = async (req, res, url) => {
    const { method } = req;
    const path = url.pathname;
    const api = '/meet/api/';

    if (method === 'GET' && path === '/') {
      return send(res, 200, homePage(defaultRoom), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (method === 'GET' && path === '/join') {
      return send(res, 302, '', { Location: joinMeeting(url) });
    }
    if (method === 'GET' && path === '/events') {
      return send(res, 200, events);
    }
    if (method === 'GET' && path.startsWith('/meet/keys/')) {
      return send(res, 200, publicKey(joinKeys, path.slice('/meet/keys/'.length)));
    }
    if (method === 'GET' && path.startsWith('/meet/control-keys/')) {
      return send(res, 200, publicKey(controlKeys, path.slice('/meet/control-keys/'.length)));
    }
    if (method === 'POST' && path.startsWith('/control/')) {
      const { status, body } = await control(path.slice('/control/'.length), url);
      return send(res, status, body);
    }
    if (!path.startsWith(api)) {
      throw new HttpError(404, 'not found');
    }

    requireBearer(req);
    const endpoint = path.slice(api.length);

    if (method === 'POST' && endpoint === 'conference') {
      const form = new URLSearchParams(await readBody(req));
      const record = approveRoom(form.get('name'), form.get('start_time'), form.get('mail_owner'));
      recordEvent('conference', record);
      return send(res, 200, record);
    }
    if (endpoint.startsWith('conference/')) {
      const id = endpoint.slice('conference/'.length);
      const record = conferences.get(id);
      if (!record) {
        throw new HttpError(404, { message: 'unknown conference' });
      }
      if (method === 'DELETE') {
        conferences.delete(id);
        recordEvent('conference/deleted', record);
      }
      return send(res, 200, record);
    }
    if (method === 'POST' && endpoint.startsWith('events/')) {
      recordEvent(endpoint, JSON.parse(await readBody(req)));
      return send(res, 200, { ok: true });
    }
    if (method === 'PUT' && endpoint === 'recordings/finished') {
      await saveRecording(req, url);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not found');
  };

  const handle = async (req, res) => {
    try {
      await route(req, res, new URL(req.url, 'http://app'));
    } catch (error) {
      if (!(error instanceof HttpError)) {
        config.log?.(`error ${error.stack}`);
      }
      send(res, error.status ?? 500, error.body ?? 'internal error');
    }
  };

  return { handle, joinKeys, controlKeys, events, approveRoom, issuedRooms, defaultRoom };
}
