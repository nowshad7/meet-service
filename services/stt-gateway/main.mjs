import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGateway, formatEvent } from './gateway.mjs';

const log = process.env.MEET_STT_LOG === '0' ? () => {} : line => console.log(line);
const started = Date.now();
let step = 'provider_required';
try {
    const modulePath = process.env.MEET_STT_PROVIDER_MODULE;
    if (!modulePath?.startsWith('/')) throw new Error('provider_required');
    const module = basename(modulePath);
    step = 'provider_import';
    const { createProvider } = await import(pathToFileURL(modulePath).href);
    step = 'provider_config';
    const provider = await createProvider();
    if (typeof provider.transcribe !== 'function' && typeof provider.openStream !== 'function') throw new Error('invalid_provider');
    step = 'gateway_config';
    const options = { log, prewarmLanguage: process.env.MEET_STT_PREWARM_LANGUAGE ?? '' };
    for (const [key, env] of Object.entries({ windowMs: 'WINDOW_MS', overlapMs: 'OVERLAP_MS',
        idleMs: 'IDLE_MS', timeoutMs: 'TIMEOUT_MS', maxQueue: 'MAX_QUEUE', maxSpeakers: 'MAX_SPEAKERS',
        maxConnections: 'MAX_CONNECTIONS', maxActiveCalls: 'MAX_ACTIVE_CALLS' })) {
        if (process.env['MEET_STT_' + env]) options[key] = Number(process.env['MEET_STT_' + env]);
    }
    const gateway = createGateway(provider, options);
    gateway.server.listen(8000, '0.0.0.0', () => log(formatEvent('ready', { provider: module,
        mode: typeof provider.openStream === 'function' ? 'stream' : 'batch',
        prewarm: typeof provider.prepare === 'function' ? 1 : 0, ms: Date.now() - started })));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
        gateway.close().finally(() => process.exit(0));
    });
} catch (error) {
    // Provider errors carry fixed codes (key_required, invalid_config, ...); nothing else is printed.
    const code = typeof error?.code === 'string' && /^[a-z_]{1,32}$/.test(error.code) ? error.code : step;
    console.error(`STT gateway startup failed; check provider and settings (${code})`);
    process.exit(1);
}
