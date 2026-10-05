local fake = require "tests.plugins.fake_prosody"

describe("mod_meet_privacy", function()
    local world, room

    local function join(resource, role, room_context)
        local occupant = fake.occupant(room, resource, role)
        local session = fake.session({ id = resource }, room_context)
        world.fire("muc-occupant-pre-join", { room = room, occupant = occupant, origin = session })
        return occupant, session
    end

    local function groupchat(occupant, session)
        local stanza = fake.stanza({ from = occupant.nick }, { body = "hello" })
        local event = { room = room, stanza = stanza, occupant = occupant, origin = session }
        return world.fire("muc-occupant-groupchat", event)
    end

    local function private_message(from, to, session)
        local stanza = fake.stanza({ from = from.nick, to = to.nick }, { body = "hi" })
        return world.fire("muc-private-message", { room = room, stanza = stanza, origin = session })
    end

    before_each(function()
        world = fake.new().load("mod_meet_privacy")
        room = fake.room("room@muc.meet.jitsi")
    end)

    it("leaves a room alone when the token has no privacy option", function()
        join("u1", "participant", {})
        assert.is_nil(room._data.meet_privacy)
        assert.is_nil(room._data.av_can_unmute)
    end)

    it("turns on media moderation when the token asks for privacy", function()
        join("u1", "moderator", { privacy = true })
        assert.is_true(room._data.meet_privacy)
        assert.is_false(room._data.av_can_unmute)
    end)

    it("keeps the first decision for the room", function()
        join("u1", "moderator", { privacy = true })
        join("u2", "participant", { privacy = false })
        assert.is_true(room._data.meet_privacy)
    end)

    it("ignores healthcheck rooms and admins", function()
        room = fake.room("__jicofo-health-check-1@muc.meet.jitsi")
        join("u1", "moderator", { privacy = true })
        assert.is_nil(room._data.meet_privacy)

        room = fake.room("room@muc.meet.jitsi")
        local occupant = fake.occupant(room, "focus", "moderator", "focus@auth.meet.jitsi/focus")
        local session = fake.session(nil, { privacy = true })
        world.fire("muc-occupant-pre-join", { room = room, occupant = occupant, origin = session })
        assert.is_nil(room._data.meet_privacy)
    end)

    it("blocks group chat from participants in privacy mode", function()
        join("host", "moderator", { privacy = true })
        local guest, session = join("guest", "participant", {})

        assert.is_true(groupchat(guest, session))
        assert.equal("In this meeting, messages go to the moderators only.", session.sent[1].error.text)
    end)

    it("lets moderators post to group chat in privacy mode", function()
        local host, session = join("host", "moderator", { privacy = true })
        assert.is_nil(groupchat(host, session))
        assert.equal(0, #session.sent)
    end)

    it("blocks only group chat when publicChat is false", function()
        join("host", "moderator", { privacy = false, publicChat = false })
        local guest, session = join("guest", "participant", {})
        local other = join("other", "participant", {})

        assert.is_true(groupchat(guest, session))
        assert.equal("Group chat is off for participants. Send a private message instead.", session.sent[1].error.text)
        assert.is_nil(private_message(guest, other, session))
    end)

    it("allows private messages only to or from moderators in privacy mode", function()
        local host = join("host", "moderator", { privacy = true })
        local guest, session = join("guest", "participant", {})
        local other = join("other", "participant", {})

        assert.is_nil(private_message(guest, host, session))
        assert.is_false(private_message(guest, other, session))
        assert.equal("forbidden", session.sent[1].error.condition)
    end)

    it("uses the deployment's notice text", function()
        local options = { meet_privacy_chat_notice = "Messages go to the host only." }
        world = fake.new({ options = options }).load("mod_meet_privacy")
        room = fake.room("room@muc.meet.jitsi")
        join("host", "moderator", { privacy = true })
        local guest, session = join("guest", "participant", {})

        groupchat(guest, session)
        assert.equal("Messages go to the host only.", session.sent[1].error.text)
    end)
end)
