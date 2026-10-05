local fake = require "tests.plugins.fake_prosody"

describe("mod_meet_single_session", function()
    local world, room

    local function join(resource, user_id)
        local occupant = fake.occupant(room, resource)
        local session = fake.session(user_id and { id = user_id } or nil)
        world.prosody.full_sessions[occupant.jid] = session
        world.fire("muc-occupant-joined", { room = room, occupant = occupant, origin = session })
        return occupant
    end

    before_each(function()
        world = fake.new().load("mod_meet_single_session")
        room = fake.room("room@muc.meet.jitsi")
    end)

    it("removes the older seat of the same user", function()
        local first = join("tab1", "u1")
        join("tab2", "u1")

        assert.equal(1, #room.removed)
        assert.equal(first.nick, room.removed[1].nick)
        assert.is_nil(room.removed[1].role)
        assert.equal("You joined this meeting from another tab or device.", room.removed[1].reason)
    end)

    it("keeps different users", function()
        join("a", "u1")
        join("b", "u2")
        assert.equal(0, #room.removed)
    end)

    it("ignores occupants without a user id", function()
        join("a", nil)
        join("b", nil)
        assert.equal(0, #room.removed)
    end)

    it("ignores healthcheck rooms", function()
        room = fake.room("__jicofo-health-check-1@muc.meet.jitsi")
        join("a", "u1")
        join("b", "u1")
        assert.equal(0, #room.removed)
    end)

    it("uses the deployment's notice text", function()
        local options = { meet_single_session_notice = "You joined this webinar from another tab or device." }
        world = fake.new({ options = options }).load("mod_meet_single_session")
        join("tab1", "u1")
        join("tab2", "u1")
        assert.equal("You joined this webinar from another tab or device.", room.removed[1].reason)
    end)
end)
