local fake = require "tests.plugins.fake_prosody"

describe("mod_meet_transcription", function()
    local world, room
    local function request()
        local stanza = {
            attr = { from = "u@meet.jitsi/web" },
            tags = { { name = "jitsi_participant_requestingTranscription" }, { name = "other" } },
        }
        function stanza:maptags(fn)
            local kept = {}
            for _, tag in ipairs(self.tags) do
                local result = fn(tag)
                if result then kept[#kept + 1] = result end
            end
            self.tags = kept
        end
        return stanza
    end
    local function session(feature, allowed)
        local origin = fake.session(nil, { transcription = { enabled = allowed, language = "bn" } })
        origin.auth_token = "verified-token"
        origin.jitsi_meet_room = "room"
        origin.jitsi_meet_context_features = { transcription = feature }
        return origin
    end
    local function join(origin, jid)
        local stanza = request()
        local occupant = fake.occupant(room, "u", "moderator", jid)
        local result = world.fire("muc-occupant-pre-join", {
            room = room, occupant = occupant, origin = origin, stanza = stanza,
        })
        return stanza, result
    end
    before_each(function()
        world = fake.new({ options = { meet_transcription_enabled = true } }).load("mod_meet_transcription")
        room = fake.room("room@muc.meet.jitsi")
    end)
    it("allows an entitled first join and subsequent start/stop requests", function()
        local origin = session(true, true)
        local stanza = join(origin)
        assert.is_true(room._data.meet_transcription)
        assert.equal(2, #stanza.tags)
        stanza = request()
        world.fire("muc-occupant-pre-change", { room = room, origin = origin, stanza = stanza })
        assert.equal(2, #stanza.tags)
    end)
    it("denies absent, false and string feature claims, including moderators", function()
        for _, value in ipairs({ false, "true", "false", {} }) do
            room = fake.room("room@muc.meet.jitsi")
            assert.equal(1, #join(session(value, true)).tags)
            assert.is_false(room._data.meet_transcription)
        end
        room = fake.room("room@muc.meet.jitsi")
        assert.equal(1, #join(session(nil, true)).tags)
    end)
    it("denies a room without explicit enabled metadata", function()
        assert.equal(1, #join(session(true, nil)).tags)
        assert.is_false(room._data.meet_transcription)
    end)
    it("does not promote a denied room when a later entitled token joins", function()
        join(session(false, false))
        assert.equal(1, #join(session(true, true)).tags)
        local stanza = request()
        world.fire("muc-occupant-pre-change", { room = room, origin = session(true, true), stanza = stanza })
        assert.equal(1, #stanza.tags)
    end)
    it("filters unauthorized updates in an entitled room", function()
        join(session(true, true))
        local stanza = request()
        world.fire("muc-occupant-pre-change", { room = room, origin = session(false, true), stanza = stanza })
        assert.equal("other", stanza.tags[1].name)
        assert.equal(1, #stanza.tags)
    end)
    it("requires verified token state and deployment opt-in", function()
        local origin = session(true, true)
        origin.auth_token = nil
        assert.equal(1, #join(origin).tags)
        world = fake.new().load("mod_meet_transcription")
        room = fake.room("room@muc.meet.jitsi")
        assert.equal(1, #join(session(true, true)).tags)
        assert.is_false(room._data.meet_transcription)
    end)
    it("runs after token verification rejects a join", function()
        world.module:hook("muc-occupant-pre-join", function() return true end, 99)
        local _, result = join(session(true, true))
        assert.is_true(result)
        assert.is_nil(room._data.meet_transcription)
    end)
    it("does not let admins or healthchecks establish entitlement", function()
        join(session(true, true), "focus@auth.meet.jitsi/focus")
        assert.is_nil(room._data.meet_transcription)
        room = fake.room("__jicofo-health-check-1@muc.meet.jitsi")
        join(session(true, true))
        assert.is_nil(room._data.meet_transcription)
    end)
    it("rejects direct hidden transcriber invitations in denied rooms", function()
        local origin = session(nil, nil)
        local _, result = join(origin, "transcriber@hidden.meet.jitsi/bot")
        assert.is_true(result)
        assert.equal("not-allowed", origin.sent[1].error.condition)
        join(session(true, true))
        local _, allowed = join(origin, "transcriber@hidden.meet.jitsi/bot")
        assert.is_nil(allowed)
    end)
end)
