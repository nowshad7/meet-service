import { controlClaims, createApp, joinClaims } from '../examples/app-node/app.mjs';

const app = createApp({ appId: 'example-app', tenant: 'acme' });
const user = { id: 'user-1', name: 'Alex Example', moderator: true };
const room = '6f1c2b9e-4a77-4f0e-9a1e-2c1f9a7d1b33';
app.issuedRooms.add(`[acme]${room}`);

let denied;
try {
  app.approveRoom('[acme]unknown', '2026-10-05T09:00:00.000Z', 'owner@meet.jitsi');
} catch (error) {
  denied = error.body;
}

const samples = {
  'join-token': joinClaims({ appId: 'example-app', tenant: 'acme', room, user, privacy: true }),
  'control-token': controlClaims({ appId: 'example-app' }),
  'room-gate-response': app.approveRoom(`[acme]${room}`, '2026-10-05T09:00:00.000Z', 'owner@meet.jitsi'),
  'room-gate-denied': denied,
};

console.log(JSON.stringify(samples, null, 2));
