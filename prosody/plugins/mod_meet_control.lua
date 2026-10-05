-- mod_meet_control.lua
--
-- POST /kick-user?conference=<room-jid>&user=<context.user.id>[&ban=false]
-- Authorization: Bearer <control token>  (same control key as /end-meeting)
--
-- Removes every occupant whose JWT context.user.id matches, and (unless
-- ban=false) remembers the id on the room so a still-valid token cannot
-- rejoin while the room lives. POST /allow-user with the same query lifts it.
-- The app should also refuse to mint new tokens for removed users.

module:set_global();

local st = require 'util.stanza';
local util = module:require "util";
local async_handler_wrapper = util.async_handler_wrapper;
local room_jid_match_rewrite = util.room_jid_match_rewrite;
local get_room_from_jid = util.get_room_from_jid;
local starts_with = util.starts_with;
local process_host_module = util.process_host_module;
local parse = require "util.http".formdecode;

local token_util;
local muc_domain_base = module:get_option_string("muc_mapper_domain_base");
local muc_domain_prefix = module:get_option_string('muc_mapper_domain_prefix', 'conference');
local muc_domain = muc_domain_prefix..'.'..muc_domain_base;
local asapKeyServer = module:get_option_string("prosody_password_public_key_repo_url", "");

local REMOVED_NOTICE = module:get_option_string("meet_control_removed_notice",
    "A moderator removed you from this meeting.");

local function user_id(session)
    local context_user = session and session.jitsi_meet_context_user;
    return context_user and context_user.id;
end

local function authorised_room(event)
    if not event.request.url.query then
        return nil, nil, 400;
    end
    local params = parse(event.request.url.query);
    if not params["conference"] or not params["user"] then
        return nil, nil, 400;
    end

    local token = event.request.headers["authorization"];
    if not token or not starts_with(token, 'Bearer ') then
        return nil, nil, 401;
    end
    local verified = token_util:process_and_verify_token({ auth_token = token:sub(8) });
    if not verified then
        return nil, nil, 401;
    end

    local room = get_room_from_jid(room_jid_match_rewrite(params["conference"]));
    if not room then
        return nil, nil, 404;
    end

    return room, params;
end

local function handle_kick(event)
    local room, params, status = authorised_room(event);
    if not room then
        return { status_code = status };
    end

    if params["ban"] ~= "false" then
        room._data.meet_banned = room._data.meet_banned or {};
        room._data.meet_banned[params["user"]] = true;
    end

    local kicked = 0;
    for _, occupant in room:each_occupant() do
        if user_id(prosody.full_sessions[occupant.jid]) == params["user"] then
            room:set_role(true, occupant.nick, nil, REMOVED_NOTICE);
            kicked = kicked + 1;
        end
    end
    module:log("info", "removed %s from %s (%d seats)", params["user"], room.jid, kicked);

    return { status_code = 200 };
end

local function handle_allow(event)
    local room, params, status = authorised_room(event);
    if not room then
        return { status_code = status };
    end
    if room._data.meet_banned then
        room._data.meet_banned[params["user"]] = nil;
    end

    return { status_code = 200 };
end

local function refuse_banned(event)
    local banned = event.room._data.meet_banned;
    local id = user_id(event.origin);
    if banned and id and banned[id] then
        event.origin.send(st.error_reply(event.stanza, "cancel", "forbidden", REMOVED_NOTICE));
        return true;
    end
end

function module.add_host(host_module)
    if host_module.host == muc_domain_base then
        process_host_module(muc_domain, function(muc_module)
            muc_module:hook("muc-occupant-pre-join", refuse_banned, 20);
        end);

        token_util = module:require "token/util".new(host_module);
        if asapKeyServer ~= "" then
            token_util:set_asap_key_server(asapKeyServer);
        end

        host_module:depends("http");
        host_module:provides("http", {
            default_path = "/";
            name = "meet_control";
            route = {
                ["POST kick-user"] = function(event) return async_handler_wrapper(event, handle_kick) end;
                ["POST allow-user"] = function(event) return async_handler_wrapper(event, handle_allow) end;
            };
        });
    end
end
