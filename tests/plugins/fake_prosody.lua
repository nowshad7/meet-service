local fake = {}

local function split_jid(jid)
    local node, host, resource = jid:match("^([^@/]+)@([^/]+)/?(.*)$")
    if not node then
        return nil, jid:match("^([^/]+)"), nil
    end
    return node, host, resource ~= "" and resource or nil
end

local function formdecode(query)
    local params = {}
    for key, value in query:gmatch("([^&=]+)=([^&]*)") do
        params[key] = value
    end
    return params
end

function fake.stanza(attr, children)
    local stanza = { attr = attr or {}, children = children or {} }
    function stanza:get_child(name)
        return self.children[name]
    end
    function stanza:get_child_text(name)
        return self.children[name]
    end
    return stanza
end

local stanza_lib = {
    error_reply = function(stanza, error_type, condition, text)
        return { attr = { to = stanza.attr.from }, error = { type = error_type, condition = condition, text = text } }
    end,
}

function fake.room(jid)
    local room = { jid = jid, _data = {}, occupants = {}, removed = {}, saved = 0 }

    function room:each_occupant()
        local nicks = {}
        for nick in pairs(self.occupants) do
            nicks[#nicks + 1] = nick
        end
        table.sort(nicks)
        local index = 0
        return function()
            index = index + 1
            local nick = nicks[index]
            if nick then
                return nick, self.occupants[nick]
            end
        end
    end

    function room:get_occupant_by_nick(nick)
        return self.occupants[nick]
    end

    function room:set_role(actor, nick, role, reason)
        self.removed[#self.removed + 1] = { actor = actor, nick = nick, role = role, reason = reason }
    end

    function room:save()
        self.saved = self.saved + 1
    end

    return room
end

function fake.occupant(room, resource, role, session_jid)
    local occupant = {
        nick = room.jid .. "/" .. resource,
        jid = session_jid or (resource .. "@meet.jitsi/web"),
        bare_jid = (session_jid or (resource .. "@meet.jitsi/web")):match("^[^/]+"),
        role = role or "participant",
    }
    room.occupants[occupant.nick] = occupant
    return occupant
end

function fake.session(user, room_context)
    local sent = {}
    return {
        jitsi_meet_context_user = user,
        jitsi_meet_context_room = room_context,
        sent = sent,
        send = function(stanza) sent[#sent + 1] = stanza end,
    }
end

local function hook(self, event, handler, priority)
    self.hooks[event] = self.hooks[event] or {}
    table.insert(self.hooks[event], { handler = handler, priority = priority or 0 })
    table.sort(self.hooks[event], function(a, b) return a.priority > b.priority end)
end

local function fire(self, event, data)
    for _, entry in ipairs(self.hooks[event] or {}) do
        local result = entry.handler(data)
        if result ~= nil then
            return result
        end
    end
end

function fake.host_module(host)
    local host_module = { host = host, hooks = {}, provided = {}, depended = {}, hook = hook, fire = fire }
    function host_module:depends(name)
        self.depended[#self.depended + 1] = name
    end
    function host_module:provides(kind, item)
        self.provided[kind] = item
    end
    return host_module
end

function fake.new(options)
    options = options or {}
    local world = {
        requests = {},
        timers = {},
        logs = {},
        rooms = {},
        hosts = {},
        verified_tokens = { ["good-token"] = true },
        asap_key_server = nil,
    }

    world.prosody = {
        version = "13.0.6",
        platform = "posix",
        full_sessions = {},
        hosts = world.hosts,
        events = { handlers = {}, add_handler = function(event, handler)
            world.prosody.events.handlers[event] = handler
        end },
    }

    world.util = {
        is_healthcheck_room = function(jid) return jid:match("^__jicofo%-health%-check") ~= nil end,
        is_transcriber = function(jid) return jid == "transcriber@hidden.meet.jitsi" end,
        is_admin = function(jid) return jid == "focus@auth.meet.jitsi" end,
        async_handler_wrapper = function(event, handler) return handler(event) end,
        room_jid_match_rewrite = function(jid) return jid end,
        get_room_from_jid = function(jid) return world.rooms[jid] end,
        starts_with = function(value, prefix) return value:sub(1, #prefix) == prefix end,
        process_host_module = function(name, callback)
            local function process_host(host)
                if host == name then
                    callback(world.module:context(host), host)
                end
            end
            if world.hosts[name] == nil then
                world.prosody.events.add_handler("host-activated", process_host)
            else
                process_host(name)
            end
        end,
    }

    world.token_util = {
        new = function()
            return {
                process_and_verify_token = function(_, session)
                    return world.verified_tokens[session.auth_token] == true
                end,
                set_asap_key_server = function(_, url) world.asap_key_server = url end,
            }
        end,
    }

    world.requires = {
        ["util.stanza"] = stanza_lib,
        ["util.json"] = { encode = function(value) return value end },
        ["util.jid"] = {
            node = function(jid) return (split_jid(jid)) end,
            split = split_jid,
        },
        ["util.http"] = { formdecode = formdecode },
        ["util.timer"] = {
            add_task = function(delay, callback)
                world.timers[#world.timers + 1] = { delay = delay, callback = callback }
            end,
        },
        ["net.http"] = {
            request = function(url, request_options, callback)
                local request = { url = url, options = request_options, callback = callback }
                world.requests[#world.requests + 1] = request
                return request
            end,
            destroy_request = function(request) request.destroyed = true end,
        },
    }

    local module = { host = options.host or "muc.meet.jitsi", hooks = {}, hook = hook }

    function module:get_option(name, default)
        local value = (options.options or {})[name]
        if value == nil then
            return default
        end
        return value
    end
    module.get_option_string = module.get_option
    module.get_option_number = module.get_option
    module.get_option_boolean = module.get_option

    function module:get_name() return options.name or "test" end
    function module:set_global() self.is_global = true end
    function module:log(level, message, ...)
        world.logs[#world.logs + 1] = { level = level, message = message:format(...) }
    end
    function module:require(name)
        if name == "util" then return world.util end
        if name == "token/util" then return world.token_util end
        error("unexpected module:require " .. name)
    end
    function module:context(host)
        return world.hosts[host].context
    end
    world.module = module

    function world.fire(event, data)
        return fire(module, event, data)
    end

    function world.add_component(host)
        local context = fake.host_module(host)
        local muc = {
            each_room = function()
                local rooms = {}
                for _, room in pairs(world.rooms) do
                    rooms[#rooms + 1] = room
                end
                local index = 0
                return function()
                    index = index + 1
                    return rooms[index]
                end
            end,
        }
        world.hosts[host] = { context = context, modules = { muc = muc } }
        return context
    end

    function world.load(plugin)
        local env = setmetatable({
            module = module,
            prosody = world.prosody,
            require = function(name) return world.requires[name] or require(name) end,
        }, { __index = _G })
        local chunk = assert(loadfile("prosody/plugins/" .. plugin .. ".lua", "t", env))
        chunk()
        return world
    end

    return world
end

return fake
