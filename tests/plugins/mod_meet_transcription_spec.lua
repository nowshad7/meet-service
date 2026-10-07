local fake = require "tests.plugins.fake_prosody"

describe("mod_meet_transcription", function()
    local world, room
    local function load(enabled)
        world = fake.new({ options = { meet_transcription_enabled = enabled } }).load("mod_meet_transcription")
        room = fake.room("room@muc.meet.jitsi")
    end
    local function join(options, capability, verified, jid)
        local occupant = fake.occupant(room, "u1", "participant", jid)
        local session = fake.session({ id = "u1" }, { transcription = options })
        session.jitsi_meet_context_features = { transcription = capability }
        if verified ~= false then
            session.auth_token = "good-token"
            session.jitsi_meet_room = "room"
        end
        world.fire("muc-occupant-pre-join", { room = room, occupant = occupant, origin = session })
    end
    before_each(function() load(true) end)

    it("requires deployment permission even with both token flags", function()
        load(false)
        join({ enabled = true, autoStart = true }, true)
        assert.is_nil(room.jitsiMetadata)
        load(nil)
        join({ enabled = true }, true)
        assert.is_nil(room.jitsiMetadata)
    end)
    it("requires a verified token and ignores absent options", function()
        join({ enabled = true }, true, false)
        assert.is_nil(room.jitsiMetadata)
        join(nil, true)
        assert.is_nil(room._data.meet_transcription)
    end)
    it("requires both token permissions and keeps the first decision", function()
        join({ enabled = true }, false)
        join({ enabled = true }, true)
        assert.is_false(room.jitsiMetadata.asyncTranscription)
    end)
    it("honors an explicit room opt out", function()
        join({ enabled = false }, true)
        assert.is_false(room.jitsiMetadata.asyncTranscription)
    end)
    it("preserves metadata and sends language and autoStart", function()
        room.jitsiMetadata = { unrelated = true, recording = { other = true } }
        local broadcasts = 0
        world.module:hook("room-metadata-changed", function() broadcasts = broadcasts + 1 end)
        join({ enabled = true, language = "bn", autoStart = true, save = true }, true)
        assert.is_true(room.jitsiMetadata.asyncTranscription)
        assert.is_true(room.jitsiMetadata.recording.isTranscribingEnabled)
        assert.is_true(room.jitsiMetadata.recording.other)
        assert.is_true(room.jitsiMetadata.unrelated)
        assert.same({ language = "bn", autoStart = true, urlParams = { lang = "bn" } },
            room.jitsiMetadata.transcription)
        join({ enabled = false, language = "en" }, true)
        assert.equal(1, broadcasts)
        assert.equal("bn", room.jitsiMetadata.transcription.language)
    end)
    it("waits for a caption UI request without autoStart", function()
        join({ enabled = true }, true)
        assert.is_true(room.jitsiMetadata.asyncTranscription)
        assert.is_false(room.jitsiMetadata.recording.isTranscribingEnabled)
        assert.is_false(room.jitsiMetadata.transcription.autoStart)
    end)
    it("ignores focus and healthcheck rooms", function()
        join({ enabled = true }, true, true, "focus@auth.meet.jitsi/focus")
        assert.is_nil(room.jitsiMetadata)
        room = fake.room("__jicofo-health-check-1@muc.meet.jitsi")
        join({ enabled = true }, true)
        assert.is_nil(room.jitsiMetadata)
    end)
end)
