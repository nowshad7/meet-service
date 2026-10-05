-- mod_meet_single_session.lua
--
-- One seat per app user: when a JWT user joins a room they are already in
-- (another tab or device), the older occupant is removed so the room shows
-- one tile and attendance sees one person.

local util = module:require 'util';
local is_admin = util.is_admin;
local is_healthcheck_room = util.is_healthcheck_room;

local REPLACED_NOTICE = module:get_option_string("meet_single_session_notice",
    "You joined this meeting from another tab or device.");

local function user_id(session)
    local context_user = session and session.jitsi_meet_context_user;
    return context_user and context_user.id;
end

module:hook("muc-occupant-joined", function(event)
    local room, occupant = event.room, event.occupant;

    if is_healthcheck_room(room.jid) or is_admin(occupant.bare_jid) then
        return;
    end

    local id = user_id(event.origin);
    if not id then
        return;
    end

    for _, other in room:each_occupant() do
        if other.nick ~= occupant.nick and user_id(prosody.full_sessions[other.jid]) == id then
            room:set_role(true, other.nick, nil, REPLACED_NOTICE);
            module:log("info", "replaced older seat of %s in %s", id, room.jid);
        end
    end
end, -1);
