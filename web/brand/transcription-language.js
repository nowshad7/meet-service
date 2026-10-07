/* Opt-in legacy Jigasi language bridge for the pinned web client. */
(() => {
    'use strict';
    let appliedRoom;
    const timer = window.setInterval(() => {
        if (!window.config?.transcription?.enabled) {
            return;
        }
        const state = window.APP?.store?.getState();
        const jwt = state?.['features/base/jwt']?.jwt;
        if (!jwt) {
            return;
        }
        let context;
        try {
            const payload = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            context = JSON.parse(window.atob(payload)).context;
        } catch (_) {
            return;
        }
        const options = context?.room?.transcription;
        if (context?.features?.transcription !== true || options?.enabled !== true
                || !['bn', 'en'].includes(options.language)) {
            return;
        }
        const room = window.APP?.conference?._room;
        if (room?.isJoined() && room !== appliedRoom) {
            room.setLocalParticipantProperty('transcription_language', options.language);
            appliedRoom = room;
        }
    }, 500);
    window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
})();
