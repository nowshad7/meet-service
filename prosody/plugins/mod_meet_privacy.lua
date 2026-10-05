-- mod_meet_privacy.lua
--
-- Privacy mode, switched on by the JWT claim context.room.privacy.
--   * Media: sets av_can_unmute=false so mod_av_moderation_component turns on
--     audio/video/desktop moderation when the first moderator joins. Jicofo
--     then keeps every participant muted at the bridge until a moderator
--     approves them ("give the stage").
--   * Chat: participants cannot post to the group chat, and may send private
--     messages to moderators only.
-- Separately, context.room.publicChat == false turns off participants'
-- group-chat posts without privacy mode (private messages stay open).
-- Hiding the filmstrip/participant list is client config (app URL hash), so
-- names stay visible to a determined participant; their camera and mic do not.

local st = require 'util.stanza';
local util = module:require 'util';
local is_admin = util.is_admin;
local is_healthcheck_room = util.is_healthcheck_room;

local CHAT_NOTICE = module:get_option_string("meet_privacy_chat_notice",
    "In this meeting, messages go to the moderators only.");
local PUBLIC_CHAT_OFF_NOTICE = module:get_option_string("meet_privacy_public_chat_off_notice",
    "Group chat is off for participants. Send a private message instead.");

local function is_moderator(room, nick)
    local occupant = nick and room:get_occupant_by_nick(nick);
    return occupant ~= nil and occupant.role == 'moderator';
end

module:hook("muc-occupant-pre-join", function(event)
    local room, occupant, session = event.room, event.occupant, event.origin;

    if room._data.meet_privacy ~= nil or is_healthcheck_room(room.jid) or is_admin(occupant.bare_jid) then
        return;
    end

    local context_room = session and session.jitsi_meet_context_room;
    if not context_room or context_room.privacy == nil then
        return;
    end

    room._data.meet_privacy = context_room.privacy == true;
    room._data.meet_no_public_chat = context_room.publicChat == false;
    if room._data.meet_privacy then
        room._data.av_can_unmute = false;
        module:log("info", "privacy mode on for %s", room.jid);
    end
end, 1);

module:hook("muc-occupant-groupchat", function(event)
    local room, stanza, occupant = event.room, event.stanza, event.occupant;

    if not (room._data.meet_privacy or room._data.meet_no_public_chat) or not stanza:get_child('body') then
        return;
    end

    if occupant and occupant.role ~= 'moderator' then
        event.origin.send(st.error_reply(stanza, "auth", "forbidden",
            room._data.meet_privacy and CHAT_NOTICE or PUBLIC_CHAT_OFF_NOTICE));
        return true;
    end
end, 60);

module:hook("muc-private-message", function(event)
    local room, stanza, origin = event.room, event.stanza, event.origin;

    if not room._data.meet_privacy or not stanza:get_child('body') then
        return;
    end

    if is_moderator(room, stanza.attr.from) or is_moderator(room, stanza.attr.to) then
        return;
    end

    local reply = st.error_reply(stanza, "auth", "forbidden", CHAT_NOTICE);
    reply.attr.to = origin.full_jid;
    origin.send(reply);
    return false;
end);
