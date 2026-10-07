-- Live captions from verified token context; deployment permission is authoritative.
local util = module:require 'util';
local enabled = module:get_option_boolean("meet_transcription_enabled", false);

module:hook("muc-occupant-pre-join", function(event)
    local room, occupant, session = event.room, event.occupant, event.origin;
    if not enabled or room._data.meet_transcription ~= nil
            or util.is_healthcheck_room(room.jid) or util.is_admin(occupant.bare_jid) then
        return;
    end

    -- token_verification runs at priority 99 and stops rejected joins.
    if not session or not session.auth_token or not session.jitsi_meet_room then
        return;
    end
    local context = session.jitsi_meet_context_room;
    local options = context and context.transcription;
    if type(options) ~= "table" then
        return;
    end
    local features = session.jitsi_meet_context_features;
    local allowed = type(features) == "table" and features.transcription == true and options.enabled == true;
    room._data.meet_transcription = allowed;
    room.jitsiMetadata = room.jitsiMetadata or {};
    room.jitsiMetadata.asyncTranscription = allowed;
    if allowed then
        local transcription = room.jitsiMetadata.transcription or {};
        transcription.autoStart = options.autoStart == true;
        if type(options.language) == "string" and options.language ~= "" then
            transcription.language = options.language;
            transcription.urlParams = transcription.urlParams or {};
            transcription.urlParams.lang = options.language;
        end
        room.jitsiMetadata.transcription = transcription;
        local recording = room.jitsiMetadata.recording or {};
        recording.isTranscribingEnabled = options.autoStart == true;
        room.jitsiMetadata.recording = recording;
    end
    module:fire_event("room-metadata-changed", { room = room });
end, 1);
