// Shared continuous-provider core for realtime speech-to-text WebSockets.
// An adapter supplies connect(language, handlers) for its vendor wire format;
// this module owns the per-speaker queue, reconnects, pre-opened (spare)
// connections and overlapping session rotation. No audio or text is logged:
// onEvent receives fixed event names with numeric or fixed-token fields only.
//
// connect(language, handlers) returns a connection:
//   { ready, closed, readyAt, bufferedAmount(), sendAudio(buffer), endAudio(), close() }
// and calls handlers.onReady(), onInterim(text), onFinal(text), onRotate() (the
// vendor asks to move on) and onFail(reason, cooldown) at most once per
// connection. Handlers can be replaced while the connection is open.

export const languagePattern = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*$/;

export function readConfig(env, prefix, defaults, limits, failure) {
    const config = {};
    for (const [name, value] of Object.entries(defaults)) {
        config[name] = Number(env[`${prefix}${name}`] ?? value);
        const max = limits[name] ?? (name.endsWith('_MS') ? 60000 : 4096);
        const min = name === 'SPARE_MS' || name === 'SESSION_MS' ? 0 : 1;
        if (!Number.isSafeInteger(config[name]) || config[name] < min || config[name] > max) throw failure('invalid_config');
    }
    return config;
}

export function createStreamingProvider({ connect, failure, maxStreams, maxQueueMs, reconnectMs,
    sessionMs = 0, drainMs = 2500, spareMs = 0, renewSpares = false }) {
    const streams = new Set();
    const spares = new Map();

    function closeSpare(sessionId) {
        const spare = spares.get(sessionId);
        if (!spare) return;
        spares.delete(sessionId); clearTimeout(spare.expiry); spare.conn.close();
    }

    function prepare({ sessionId, language } = {}) {
        if (!spareMs || typeof sessionId !== 'string' || typeof language !== 'string' || !languagePattern.test(language)) return;
        const current = spares.get(sessionId);
        if (current && current.language === language && !current.conn.closed) return;
        closeSpare(sessionId);
        if (streams.size + spares.size >= maxStreams) return;
        const spare = { language };
        const drop = () => { if (spares.get(sessionId) === spare) { spares.delete(sessionId); clearTimeout(spare.expiry); } };
        spare.conn = connect(language, { onReady() {}, onInterim() {}, onFinal() {}, onRotate() { spare.conn.close(); drop(); }, onFail: drop });
        // Unused spares are closed before the vendor's session limit; Gemini's renew.
        spare.expiry = setTimeout(() => {
            if (spares.get(sessionId) !== spare) return;
            closeSpare(sessionId);
            if (renewSpares) prepare({ sessionId, language });
        }, spareMs);
        spares.set(sessionId, spare);
    }

    function adopt(sessionId, language) {
        const spare = spares.get(sessionId);
        if (!spare || spare.language !== language || spare.conn.closed) return null;
        spares.delete(sessionId); clearTimeout(spare.expiry);
        return spare.conn;
    }

    function openStream({ sessionId, language, sampleRate, onResult, onEvent }) {
        if (sampleRate !== 16000 || typeof onResult !== 'function' || typeof language !== 'string' ||
            !languagePattern.test(language)) throw failure('invalid_audio');
        if (streams.size >= maxStreams) throw failure('stream_limit');
        // A speaker who is talking beats a connection kept warm for someone else.
        if (streams.size + spares.size >= maxStreams && spares.get(sessionId)?.language !== language) {
            closeSpare([...spares.keys()].find(id => id !== sessionId) ?? sessionId);
        }
        const maxBytes = maxQueueMs * 32;
        let active = null, next = null, draining = null;
        let interim = '', held = '', queue = [], queueBytes = 0, endPending = false, stopped = false;
        let retry, rotateTimer, rotateRetry, drainTimer, attempts = 0, rotateAttempts = 0;

        function event(name, fields = {}) {
            try { onEvent?.(name, fields); } catch { /* logging failure */ }
        }
        function emit(text, isFinal) {
            text = typeof text === 'string' ? text.trim() : '';
            if (stopped || !text) return;
            try { onResult({ text: text.slice(0, 16000), isFinal }); } catch { /* consumer failure */ }
        }
        function commit() {
            if (interim) emit(interim, true);
            interim = '';
        }
        function show(text) {
            if (typeof text !== 'string' || !text.trim() || text === interim) return;
            interim = text; emit(text, false);
        }
        function release() {
            const shown = held; held = '';
            if (shown) show(shown);
        }
        function endDrain() {
            if (!draining) return;
            clearTimeout(drainTimer);
            const old = draining; draining = null;
            commit(); old.close(); release();
        }
        function drain() {
            if (stopped || !active?.ready || active.closed) return;
            while (queue.length && active?.ready && !active.closed && active.bufferedAmount() < 65536) {
                const audio = queue.shift(); queueBytes -= audio.length;
                active.sendAudio(audio); // a send failure replaces or clears active
            }
            if (!queue.length && endPending && active?.ready) { endPending = false; active.endAudio(); }
        }
        function scheduleRotate(conn) {
            clearTimeout(rotateTimer);
            if (!sessionMs) return;
            rotateTimer = setTimeout(rotate, Math.max(0, conn.readyAt + sessionMs - Date.now()));
        }
        // Open the next connection while the current one keeps streaming; audio
        // switches only once it is ready, so nothing is dropped at the change.
        function rotate() {
            if (stopped || next || !active?.ready) return;
            event('provider_rotate');
            next = open();
        }
        function switchTo(conn) {
            const old = active;
            active = conn; next = null; attempts = 0; rotateAttempts = 0;
            scheduleRotate(conn);
            if (old) {
                endDrain();
                // The old session finishes the words already sent and keeps the
                // caption until its final; the new session's text waits behind it.
                draining = old;
                old.endAudio();
                drainTimer = setTimeout(endDrain, drainMs);
                event('provider_switched', { warm: 0 });
            }
            drain();
        }
        function reconnect(cooldown) {
            if (stopped || retry) return;
            attempts++;
            const wait = cooldown || attempts > 5 ? 60000 : Math.min(5000, reconnectMs * 2 ** (attempts - 1));
            event('provider_reconnect', { attempt: attempts, wait_ms: wait });
            retry = setTimeout(() => { retry = null; if (!stopped && !active) active = open(); }, wait);
        }
        function handlers(conn) {
            return {
                onReady() {
                    if (stopped) return;
                    if (conn === next) { event('provider_ready', { ms: Date.now() - conn.openedAt, warm: 0, rotation: 1 }); switchTo(conn); }
                    else if (conn === active) {
                        event('provider_ready', { ms: Date.now() - conn.openedAt, warm: conn.warm ? 1 : 0, rotation: 0 });
                        attempts = 0; scheduleRotate(conn); drain();
                    }
                },
                onInterim(text) {
                    if (stopped) return;
                    if (conn === draining) show(text);
                    else if (conn === active) {
                        if (!draining) show(text);
                        else if (!interim) { held = text; endDrain(); }
                        else held = text;
                    }
                },
                onFinal(text) {
                    if (stopped) return;
                    const words = typeof text === 'string' && text.trim() ? text : null;
                    if (conn === draining) {
                        clearTimeout(drainTimer); draining = null;
                        if (words) { interim = ''; emit(words, true); } else commit();
                        conn.close(); release();
                    } else if (conn === active) {
                        if (draining) endDrain();
                        held = '';
                        if (words) { interim = ''; emit(words, true); } else commit();
                    }
                },
                onRotate() {
                    if (conn === active) rotate();
                },
                onFail(reason, cooldown = false) {
                    if (stopped) return;
                    event('provider_error', { reason, cooldown: cooldown ? 1 : 0 });
                    if (conn === draining) { endDrain(); return; }
                    if (conn === next) {
                        next = null; rotateAttempts++;
                        clearTimeout(rotateRetry);
                        rotateRetry = setTimeout(rotate, cooldown ? 60000 : Math.min(5000, reconnectMs * 2 ** (rotateAttempts - 1)));
                        return;
                    }
                    if (conn !== active) return;
                    active = null; clearTimeout(rotateTimer);
                    // Commit what the failed session showed; words in flight are lost.
                    endDrain(); commit();
                    if (next) { active = next; next = null; return; } // already reconnecting via rotation
                    reconnect(cooldown);
                }
            };
        }
        function open() {
            const conn = connect(language, {});
            conn.openedAt ??= Date.now();
            conn.handlers = handlers(conn);
            return conn;
        }
        const warm = adopt(sessionId, language);
        if (warm) {
            warm.handlers = handlers(warm); warm.warm = true;
            active = warm;
            if (warm.ready) {
                event('provider_ready', { ms: 0, warm: 1, rotation: 0 });
                scheduleRotate(warm); queueMicrotask(drain);
            }
        } else active = open();
        const pump = setInterval(drain, 20);
        const stream = {
            sessionId,
            write(audio) {
                if (stopped) return;
                if (!Buffer.isBuffer(audio) || audio.length % 2) throw failure('invalid_audio');
                // Jigasi supplies PCM16 LE mono 16 kHz; send it unchanged in 100 ms units.
                for (let offset = 0; offset < audio.length; offset += 3200) {
                    const chunk = Buffer.from(audio.subarray(offset, offset + 3200));
                    while (queue.length && queueBytes + chunk.length > maxBytes) queueBytes -= queue.shift().length;
                    if (chunk.length <= maxBytes) { queue.push(chunk); queueBytes += chunk.length; }
                }
                drain();
            },
            endAudio() {
                if (stopped) return;
                endPending = true; drain();
            },
            close() {
                if (stopped) return;
                stopped = true; clearInterval(pump);
                for (const timer of [retry, rotateTimer, rotateRetry, drainTimer]) clearTimeout(timer);
                for (const conn of [active, next, draining]) conn?.close();
                active = next = draining = null;
                queue = []; queueBytes = 0; interim = held = '';
                streams.delete(stream);
            }
        };
        streams.add(stream);
        return stream;
    }

    return {
        openStream,
        prepare,
        releaseSession({ sessionId }) {
            closeSpare(sessionId);
            for (const stream of streams) if (stream.sessionId === sessionId) stream.close();
        }
    };
}
