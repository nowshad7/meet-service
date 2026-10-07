-- Legacy Jigasi captions: token entitlement AND deployment opt-in are required.
local st = require 'util.stanza';
local util = module:require 'util';
local enabled = module:get_option_boolean("meet_transcription_enabled", false);

local function entitled(session)
    local features = session and session.jitsi_meet_context_features;
    return session and session.auth_token and session.jitsi_meet_room
        and type(features) == "table" and features.transcription == true;
end

local function filter_request(event)
    if enabled and event.room._data.meet_transcription == true and entitled(event.origin) then
        return;
    end
    if event.stanza then
        event.stanza:maptags(function(tag)
            if tag.name ~= "jitsi_participant_requestingTranscription" then
                return tag;
            end
        end);
    end
end

module:hook("muc-occupant-pre-join", function(event)
    local room, occupant, session = event.room, event.occupant, event.origin;
    if util.is_healthcheck_room(room.jid) then
        filter_request(event);
        return;
    end
    -- Even a directly invited hidden transcriber cannot enter a denied room.
    if util.is_transcriber(occupant.bare_jid) then
        if not enabled or room._data.meet_transcription ~= true then
            session.send(st.error_reply(event.stanza, "cancel", "not-allowed", "Transcription disabled for this room"));
            return true;
        end
        filter_request(event);
        return;
    end
    if not util.is_admin(occupant.bare_jid) and room._data.meet_transcription == nil then
        local context = session and session.jitsi_meet_context_room;
        local options = context and context.transcription;
        room._data.meet_transcription = enabled and entitled(session) == true
            and type(options) == "table" and options.enabled == true;
    end
    filter_request(event);
end, 1); -- after token_verification (99), before the presence is saved/broadcast

-- Includes ordinary presence updates and nickname changes, before MUC broadcasts.
module:hook("muc-occupant-pre-change", filter_request, 1);
