/* Opt-in legacy Jigasi captions for the pinned web client: speaker language and room auto-start. */
(() => {
    'use strict';
    // Same action as the CC panel's "Start", without a translation language,
    // which Jigasi's Whisper adapter would send instead of the speaker's.
    const START = { type: 'SET_REQUESTING_SUBTITLES', enabled: true, displaySubtitles: true, language: null,
        forceBackendRecordingOn: false, isRecordingRequested: false, skipMetadataUpdate: false };
    const RETRY_MS = 10000;
    const ON_STAGE_KEY = 'meet-captions-on-stage';
    let appliedRoom, heldRoom, unsubscribe;
    let startedAt = 0;
    let previous = {};
    let userStopped = false;

    function options() {
        if (!window.config?.transcription?.enabled) {
            return null;
        }
        const jwt = window.APP?.store?.getState()?.['features/base/jwt']?.jwt;
        if (!jwt) {
            return null;
        }
        let context;
        try {
            const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            context = JSON.parse(window.atob(payload)).context;
        } catch (_) {
            return null;
        }
        const room = context?.room?.transcription;
        if (context?.features?.transcription !== true || room?.enabled !== true
                || !['bn', 'en'].includes(room.language)) {
            return null;
        }
        return room;
    }

    // An auto-started moderator keeps the room's transcriber while they are
    // in it; turning captions off then only hides them for this user.
    function hold(room) {
        if (heldRoom === room || typeof room.setLocalParticipantProperty !== 'function') {
            return;
        }
        const set = room.setLocalParticipantProperty;
        room.setLocalParticipantProperty = function (name, value, ...rest) {
            if (name === 'requestingTranscription' && !value) {
                return undefined;
            }
            return set.call(this, name, value, ...rest);
        };
        heldRoom = room;
    }

    // The pinned client shows captions only in the chat panel's tab unless
    // "Show subtitles on stage" is on. Switch it on once per browser; after
    // that the user's own setting (kept in their browser) stands.
    function showOnStageOnce(state) {
        try {
            if (window.localStorage.getItem(ON_STAGE_KEY)) {
                return;
            }
            window.localStorage.setItem(ON_STAGE_KEY, '1');
        } catch (_) {
            return;
        }
        if (state['features/base/settings']?.showSubtitlesOnStage !== true) {
            window.APP.store.dispatch({ type: 'SETTINGS_UPDATED', settings: { showSubtitlesOnStage: true } });
        }
    }

    function autoStart(state, room) {
        const subtitles = state['features/subtitles'] || {};
        const transcribing = state['features/transcribing']?.isTranscribing === true;
        const requesting = subtitles._requestingSubtitles === true;
        // Off while the transcriber stays is the user's choice; TRANSCRIBER_LEFT
        // resets every client at once and is not.
        if (previous.room === room && previous.requesting && !requesting && !(previous.transcribing && !transcribing)) {
            userStopped = true;
        }
        // Turning captions back on lifts that choice, so a transcriber restart re-enables them.
        if (requesting) {
            userStopped = false;
        }
        previous = { room, requesting, transcribing };
        if (requesting || userStopped) {
            return;
        }
        const moderator = state['features/base/participants']?.local?.role === 'moderator';
        if (moderator) {
            hold(room);
        }
        // Moderators request the transcriber as the class starts (again if it
        // left); everyone else turns captions on once it is in the room.
        const now = Date.now();
        if (transcribing || (moderator && now - startedAt >= RETRY_MS)) {
            startedAt = now;
            window.APP.store.dispatch(START);
            showOnStageOnce(state);
        }
    }

    function tick() {
        const room = window.APP?.conference?._room;
        const settings = options();
        if (!settings || !room?.isJoined()) {
            return;
        }
        if (room !== appliedRoom) {
            room.setLocalParticipantProperty('transcription_language', settings.language);
            appliedRoom = room;
        }
        if (settings.autoStart === true) {
            if (!unsubscribe) {
                unsubscribe = window.APP.store.subscribe(tick);
            }
            autoStart(window.APP.store.getState(), room);
        }
    }

    const timer = window.setInterval(tick, 500);
    window.addEventListener('pagehide', () => {
        window.clearInterval(timer);
        unsubscribe?.();
    }, { once: true });
})();
