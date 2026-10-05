local fake = require "tests.plugins.fake_prosody"

describe("mod_meet_events", function()
    local world, main, breakout

    local options = {
        muc_component = "muc.meet.jitsi",
        breakout_component = "breakout.meet.jitsi",
        muc_mapper_domain_base = "meet.jitsi",
        api_prefix = "http://app.internal/meet/api",
        api_headers = { Authorization = "Bearer secret" },
        api_timeout = 10,
        include_speaker_stats = true,
        include_user_info = true,
    }

    local function load(overrides)
        local merged = {}
        for key, value in pairs(options) do merged[key] = value end
        for key, value in pairs(overrides or {}) do merged[key] = value end
        world = fake.new({ host = "events.meet.jitsi", options = merged })
        main = world.add_component("muc.meet.jitsi")
        breakout = world.add_component("breakout.meet.jitsi")
        world.load("mod_meet_events")
    end

    local function create_room(component, jid, meeting_id)
        local room = fake.room(jid)
        room._data.meetingId = meeting_id
        world.rooms[jid] = room
        component:fire("muc-room-created", { room = room })
        return room
    end

    local function join(component, room, resource, user)
        local occupant = { jid = room.jid .. "/" .. resource, get_presence = function() return fake.stanza() end }
        component:fire("muc-occupant-joined", { room = room, occupant = occupant, origin = fake.session(user) })
        return occupant
    end

    local function last_request()
        return world.requests[#world.requests]
    end

    before_each(function() load() end)

    it("posts room created with the room attributes and the bearer header", function()
        create_room(main, "room@muc.meet.jitsi", "m-1")

        local request = last_request()
        assert.equal("http://app.internal/meet/api/events/room/created", request.url)
        assert.equal("POST", request.options.method)
        assert.equal("Bearer secret", request.options.headers.Authorization)
        assert.equal("application/json", request.options.headers["Content-Type"])
        assert.same({
            event_name = "muc-room-created",
            created_at = request.options.body.created_at,
            is_breakout = false,
            room_jid = "room@muc.meet.jitsi",
            room_name = "room",
            meeting_id = "m-1",
        }, request.options.body)
    end)

    it("posts joined and left with the token user and the active count", function()
        local room = create_room(main, "room@muc.meet.jitsi", "m-1")
        local occupant = join(main, room, "a", { id = "u1", name = "Ana", email = "ana@example.org", moderator = true })

        local joined = last_request()
        assert.equal("http://app.internal/meet/api/events/occupant/joined", joined.url)
        assert.equal("muc-occupant-joined", joined.options.body.event_name)
        assert.equal(1, joined.options.body.active_occupants_count)
        assert.equal("u1", joined.options.body.occupant.id)
        assert.equal("Ana", joined.options.body.occupant.name)
        assert.is_true(joined.options.body.occupant.moderator)
        assert.equal(occupant.jid, joined.options.body.occupant.occupant_jid)

        room.speakerStats = { [occupant.jid] = { totalDominantSpeakerTime = 4200 } }
        main:fire("muc-occupant-left", { room = room, occupant = occupant })

        local left = last_request()
        assert.equal("http://app.internal/meet/api/events/occupant/left", left.url)
        assert.equal(0, left.options.body.active_occupants_count)
        assert.equal(4200, left.options.body.occupant.total_dominant_speaker_time)
        assert.is_number(left.options.body.occupant.left_at)
    end)

    it("posts every occupant when the room is destroyed", function()
        local room = create_room(main, "room@muc.meet.jitsi", "m-1")
        local a = join(main, room, "a", { id = "u1" })
        join(main, room, "b", { id = "u2" })
        main:fire("muc-occupant-left", { room = room, occupant = a })
        main:fire("muc-room-destroyed", { room = room })

        local request = last_request()
        assert.equal("http://app.internal/meet/api/events/room/destroyed", request.url)
        assert.equal(2, #request.options.body.all_occupants)
        assert.is_number(request.options.body.destroyed_at)
    end)

    it("copies only id, name and email without include_user_info", function()
        load({ include_user_info = false })
        local room = create_room(main, "room@muc.meet.jitsi", "m-1")
        join(main, room, "a", { id = "u1", name = "Ana", email = "e", moderator = true })

        local occupant = last_request().options.body.occupant
        assert.equal("u1", occupant.id)
        assert.is_nil(occupant.moderator)
    end)

    it("skips healthcheck rooms and the focus user", function()
        create_room(main, "__jicofo-health-check-1@muc.meet.jitsi", "m-h")
        assert.equal(0, #world.requests)

        local room = create_room(main, "room@muc.meet.jitsi", "m-1")
        local focus = { jid = "focus@auth.meet.jitsi/focus" }
        main:fire("muc-occupant-joined", { room = room, occupant = focus, origin = fake.session(nil) })
        assert.equal(1, #world.requests)
    end)

    it("reports breakout rooms against their main room", function()
        local parent = create_room(main, "room@muc.meet.jitsi", "m-1")
        parent._data.breakout_rooms_active = true
        parent._data.breakout_rooms = { ["group1@breakout.meet.jitsi"] = true }

        create_room(breakout, "group1@breakout.meet.jitsi", "b-1")

        local body = last_request().options.body
        assert.is_true(body.is_breakout)
        assert.equal("room@muc.meet.jitsi", body.room_jid)
        assert.equal("room", body.room_name)
        assert.equal("group1", body.breakout_room_id)
        assert.equal("m-1", body.meeting_id)
        assert.equal("b-1", body.breakout_meeting_id)
    end)

    it("retries on 5xx and network errors but not on 4xx", function()
        create_room(main, "room@muc.meet.jitsi", "m-1")
        local request = last_request()

        request.callback("", 503)
        local retries = 0
        for _, timer in ipairs(world.timers) do
            if timer.delay == 1 then retries = retries + 1 end
        end
        assert.equal(1, retries)

        world.timers = {}
        create_room(main, "other@muc.meet.jitsi", "m-2")
        last_request().callback("", 404)
        for _, timer in ipairs(world.timers) do
            assert.not_equal(1, timer.delay)
        end
    end)

    it("disables itself without api_prefix", function()
        load({ api_prefix = false })
        create_room(main, "room@muc.meet.jitsi", "m-1")
        assert.equal(0, #world.requests)
        assert.equal("error", world.logs[1].level)
    end)
end)
