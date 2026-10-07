import { pathToFileURL } from 'node:url';
import { createGateway } from './gateway.mjs';

try {
    const modulePath = process.env.MEET_STT_PROVIDER_MODULE;
    if (!modulePath?.startsWith('/')) throw new Error('provider_required');
    const { createProvider } = await import(pathToFileURL(modulePath).href);
    const provider = await createProvider();
    if (typeof provider.transcribe !== 'function') throw new Error('invalid_provider');
    const options = {};
    for (const [key, env] of Object.entries({ windowMs: 'WINDOW_MS', overlapMs: 'OVERLAP_MS',
        idleMs: 'IDLE_MS', timeoutMs: 'TIMEOUT_MS', maxQueue: 'MAX_QUEUE', maxSpeakers: 'MAX_SPEAKERS',
        maxConnections: 'MAX_CONNECTIONS', maxActiveCalls: 'MAX_ACTIVE_CALLS' })) {
        if (process.env['MEET_STT_' + env]) options[key] = Number(process.env['MEET_STT_' + env]);
    }
    const gateway = createGateway(provider, options);
    gateway.server.listen(8000, '0.0.0.0');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
        gateway.close().finally(() => process.exit(0));
    });
} catch {
    console.error('STT gateway startup failed; check provider and settings');
    process.exit(1);
}
