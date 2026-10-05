local fake = require "tests.plugins.fake_prosody"

describe("mod_meet_control", function()
    local world, main_host, muc_host, room

    local function call(route, query, token)
        local handler = main_host.provided.http.route["POST " .. route]
        return handler({
            request = { url = { query = query }, headers = { authorization = token and ("Bearer " .. token) } },
        })
    end

    local function seat(resource, user_id)
        local occupant = fake.occupant(room, resource)
        world.prosody.full_sessions[occupant.jid] = fake.session({ id = user_id })
        return occupant
    end

    local function pre_join(user_id)
        local session = fake.session({ id = user_id })
        local stanza = fake.stanza({ from = user_id .. "@meet.jitsi/web" })
        local result = muc_host:fire("muc-occupant-pre-join", { room = room, origin = session, stanza = stanza })
        return result, session
    end

    local function load_on_main_host(muc_active)
        world = fake.new({ options = {
            muc_mapper_domain_base = "meet.jitsi",
            muc_mapper_domain_prefix = "muc",
            prosody_password_public_key_repo_url = "http://app.internal/control-keys",
        } })
        if muc_active then
            muc_host = world.add_component("muc.meet.jitsi")
        end
        world.load("mod_meet_control")
        main_host = fake.host_module("meet.jitsi")
        world.module.add_host(main_host)
        room = fake.room("room@muc.meet.jitsi")
        world.rooms[room.jid] = room
    end

    before_each(function()
        load_on_main_host(true)
    end)

    it("is a global module serving its routes on the main host", function()
        assert.is_true(world.module.is_global)
        assert.equal("meet_control", main_host.provided.http.name)
        assert.same({ "http" }, main_host.depended)
        assert.equal("http://app.internal/control-keys", world.asap_key_server)
    end)

    it("answers 400 without a query or without conference and user", function()
        assert.equal(400, call("kick-user", nil, "good-token").status_code)
        assert.equal(400, call("kick-user", "conference=room@muc.meet.jitsi", "good-token").status_code)
    end)

    it("answers 401 without a valid control token", function()
        local query = "conference=room@muc.meet.jitsi&user=u1"
        assert.equal(401, call("kick-user", query, nil).status_code)
        assert.equal(401, call("kick-user", query, "join-token").status_code)
    end)

    it("answers 404 for an unknown room", function()
        assert.equal(404, call("kick-user", "conference=gone@muc.meet.jitsi&user=u1", "good-token").status_code)
        assert.equal(404, call("allow-user", "conference=gone@muc.meet.jitsi&user=u1", "good-token").status_code)
    end)

    it("removes every seat of the user and bans them", function()
        local tab1 = seat("tab1", "u1")
        local tab2 = seat("tab2", "u1")
        seat("other", "u2")

        assert.equal(200, call("kick-user", "conference=room@muc.meet.jitsi&user=u1", "good-token").status_code)

        assert.equal(2, #room.removed)
        assert.same({ tab1.nick, tab2.nick }, { room.removed[1].nick, room.removed[2].nick })
        assert.equal("A moderator removed you from this meeting.", room.removed[1].reason)
        assert.is_true(room._data.meet_banned.u1)
    end)

    it("keeps a banned user out until allow-user", function()
        call("kick-user", "conference=room@muc.meet.jitsi&user=u1", "good-token")

        local refused, session = pre_join("u1")
        assert.is_true(refused)
        assert.equal("forbidden", session.sent[1].error.condition)
        assert.is_nil(pre_join("u2"))

        assert.equal(200, call("allow-user", "conference=room@muc.meet.jitsi&user=u1", "good-token").status_code)
        assert.is_nil(pre_join("u1"))
    end)

    it("bans on a MUC component activated after the main host", function()
        load_on_main_host(false)
        muc_host = world.add_component("muc.meet.jitsi")
        world.prosody.events.handlers["host-activated"]("muc.meet.jitsi")

        call("kick-user", "conference=room@muc.meet.jitsi&user=u1", "good-token")
        assert.is_true(pre_join("u1"))
    end)

    it("does not ban when ban=false", function()
        seat("tab1", "u1")
        call("kick-user", "conference=room@muc.meet.jitsi&user=u1&ban=false", "good-token")
        assert.equal(1, #room.removed)
        assert.is_nil(pre_join("u1"))
    end)

    it("uses the deployment's notice text", function()
        world = fake.new({ options = {
            muc_mapper_domain_base = "meet.jitsi",
            muc_mapper_domain_prefix = "muc",
            meet_control_removed_notice = "A host removed you from this webinar.",
        } }).load("mod_meet_control")
        world.module.add_host(main_host)
        world.rooms[room.jid] = room
        seat("tab1", "u1")

        call("kick-user", "conference=room@muc.meet.jitsi&user=u1", "good-token")
        assert.equal("A host removed you from this webinar.", room.removed[1].reason)
    end)
end)
