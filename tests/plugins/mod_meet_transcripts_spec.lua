local fake = require "tests.plugins.fake_prosody"
local lfs = require "lfs"

describe("mod_meet_transcripts", function()
    local world, main, breakout, dir, umask, encoded

    local options = {
        muc_component = "muc.meet.jitsi",
        api_prefix = "http://app.internal/meet/api",
        api_headers = { Authorization = "Bearer secret" },
        api_timeout = 10,
    }

    local function files()
        local names = {}
        if lfs.attributes(dir, "mode") == "directory" then
            for name in lfs.dir(dir) do
                if name ~= "." and name ~= ".." then names[#names + 1] = name end
            end
        end
        table.sort(names)
        return names
    end

    local function write(name, content, modified)
        lfs.mkdir(dir)
        local file = assert(io.open(dir .. "/" .. name, "wb"))
        file:write(content)
        file:close()
        if modified then lfs.touch(dir .. "/" .. name, modified, modified) end
    end

    local function load(overrides)
        local merged = { spool_dir = dir }
        for key, value in pairs(options) do merged[key] = value end
        for key, value in pairs(overrides or {}) do merged[key] = value end
        world = fake.new({ host = "transcripts.meet.jitsi", options = merged })
        encoded = {}
        world.requires["util.json"] = {
            null = setmetatable({}, { __name = "json.null" }),
            encode = function(value)
                encoded[#encoded + 1] = value
                return "json:" .. #encoded
            end,
        }
        world.requires["util.pposix"] = {
            umask = function(mask)
                local old = umask
                umask = mask
                return old
            end,
        }
        world.requires["util.uuid"] = { generate = function() return "generated-id" end }
        world.requires["util.time"] = { now = function() return 1792220470.5 end }
        world.requires["lfs"] = lfs
        main = world.add_component("muc.meet.jitsi")
        breakout = world.add_component("breakout.meet.jitsi")
        world.load("mod_meet_transcripts")
    end

    local function create_room(jid, save, meeting_id)
        local room = fake.room(jid or "[acme]room@muc.meet.jitsi")
        room._data.meetingId = meeting_id or "4e6c0f6c-2d8b-4c55-9a8e-1f3f0d6f9b21"
        room._data.meet_transcription = true
        room._data.meet_transcription_save = save ~= false
        room._data.meet_transcription_language = "bn"
        main:fire("muc-room-created", { room = room })
        return room
    end

    local function join(room, resource, user, bare)
        local occupant = { nick = room.jid .. "/" .. resource, jid = (bare or (resource .. "@meet.jitsi")) .. "/web",
            bare_jid = bare or (resource .. "@meet.jitsi") }
        main:fire("muc-occupant-joined", { room = room, occupant = occupant, origin = fake.session(user) })
        return occupant
    end

    local function caption(room, resource, message_id, text, timestamp)
        return main:fire("jitsi-transcript-received", {
            room = room,
            transcription = {
                type = "transcription-result",
                message_id = message_id,
                participant = { id = resource, name = "presence name" },
                transcript = { { text = text } },
                language = "bn",
                timestamp = timestamp or 1792220461230,
                is_interim = false,
            },
        })
    end

    local function destroy(room)
        main:fire("muc-room-destroyed", { room = room })
    end

    local function body(request)
        return encoded[tonumber(request.options.body:match("^json:(%d+)$"))]
    end

    local function timers_with(delay)
        local found = {}
        for _, entry in ipairs(world.timers) do
            if entry.delay == delay then found[#found + 1] = entry end
        end
        return found
    end

    before_each(function()
        dir = os.tmpname()
        os.remove(dir)
        dir = dir .. "-spool"
        umask = "022"
        load()
    end)

    after_each(function()
        for _, name in ipairs(files()) do os.remove(dir .. "/" .. name) end
        lfs.rmdir(dir)
    end)

    it("posts one transcript with verified speakers when an entitled room with save ends", function()
        local room = create_room()
        join(room, "a1", { id = "teacher.rahman", name = "Rahman Sir" })
        join(room, "b2", { id = "student.nila", name = "Nila" })
        assert.is_nil(caption(room, "b2", "m-2", "স্যার, একটা প্রশ্ন ছিল।", 1792220470100))
        assert.is_nil(caption(room, "a1", "m-1", "আজকে আমরা photosynthesis নিয়ে কথা বলব।", 1792220461230))
        assert.equal(0, #world.requests)
        destroy(room)

        assert.equal(1, #world.requests)
        local request = world.requests[1]
        assert.equal("http://app.internal/meet/api/transcripts", request.url)
        assert.equal("POST", request.options.method)
        assert.equal("Bearer secret", request.options.headers.Authorization)
        assert.equal("application/json", request.options.headers["Content-Type"])
        local payload = body(request)
        assert.equal("transcript-finished", payload.event_name)
        assert.equal("4e6c0f6c-2d8b-4c55-9a8e-1f3f0d6f9b21", payload.key)
        assert.equal(payload.key, payload.meeting_id)
        assert.equal("[acme]room", payload.room_name)
        assert.equal("[acme]room@muc.meet.jitsi", payload.room_jid)
        assert.is_false(payload.is_breakout)
        assert.equal("bn", payload.language)
        assert.is_false(payload.truncated)
        assert.equal(2, payload.line_count)
        assert.is_number(payload.created_at)
        assert.is_number(payload.destroyed_at)
        assert.same({
            id = "m-1", user_id = "teacher.rahman", name = "Rahman Sir", language = "bn",
            start_ms = 1792220461230, end_ms = 1792220470500, text = "আজকে আমরা photosynthesis নিয়ে কথা বলব।",
        }, payload.lines[1])
        assert.equal("student.nila", payload.lines[2].user_id)
        assert.same({ "4e6c0f6c-2d8b-4c55-9a8e-1f3f0d6f9b21.json" }, files())
        assert.equal("json:1", request.options.body)
    end)

    it("never logs caption text", function()
        local room = create_room()
        join(room, "a1", { id = "u1" })
        caption(room, "a1", "m-1", "secret words")
        destroy(room)
        world.requests[1].callback("", 503)
        for _, entry in ipairs(world.logs) do
            assert.is_nil(entry.message:find("secret words", 1, true))
        end
    end)

    it("saves nothing for rooms without save, without entitlement, or healthchecks", function()
        for _, setup in ipairs({
            function(room) room._data.meet_transcription_save = false end,
            function(room) room._data.meet_transcription = false end,
            function(room) room._data.meet_transcription_save = nil end,
        }) do
            local room = create_room()
            setup(room)
            join(room, "a1", { id = "u1" })
            assert.is_nil(caption(room, "a1", "m-1", "hello"))
            destroy(room)
        end
        local health = create_room("__jicofo-health-check-1@muc.meet.jitsi")
        assert.is_nil(health.meet_transcript)
        assert.equal(0, #world.requests)
        assert.same({}, files())
    end)

    it("does not post a room that had no captions", function()
        local room = create_room()
        join(room, "a1", { id = "u1" })
        destroy(room)
        assert.equal(0, #world.requests)
        assert.is_nil(room.meet_transcript)
    end)

    it("attributes a final that arrives after its speaker left, and skips system occupants", function()
        local room = create_room()
        local speaker = join(room, "a1", { id = "u1", name = "Ana" })
        join(room, "focus", { id = "focus-user" }, "focus@auth.meet.jitsi")
        join(room, "tr", { id = "bot" }, "transcriber@hidden.meet.jitsi")
        assert.same({ [room.jid .. "/a1"] = { id = "u1", name = "Ana" } }, room.meet_transcript.speakers)
        main:fire("muc-occupant-left", { room = room, occupant = speaker })
        caption(room, "a1", "m-1", "late final")
        caption(room, "unknown", "m-2", "who said this")
        destroy(room)

        local lines = body(world.requests[1]).lines
        assert.equal("u1", lines[1].user_id)
        assert.equal("Ana", lines[1].name)
        assert.equal(world.requires["util.json"].null, lines[2].user_id)
        assert.equal(world.requires["util.json"].null, lines[2].name)
        assert.is_nil(room.meet_transcript)
    end)

    it("dedupes by message id and keeps arrival order for equal start times", function()
        local room = create_room()
        join(room, "a1", { id = "u1" })
        caption(room, "a1", "m-1", "first", 100)
        caption(room, "a1", "m-1", "first again", 100)
        caption(room, "a1", "m-2", "second", 100)
        caption(room, "a1", "m-0", "earlier", 50)
        destroy(room)

        local payload = body(world.requests[1])
        assert.equal(3, payload.line_count)
        assert.same({ "earlier", "first", "second" },
            { payload.lines[1].text, payload.lines[2].text, payload.lines[3].text })
    end)

    it("sets truncated at the line and text caps without blocking captions", function()
        load({ max_lines = 2 })
        local room = create_room()
        for index = 1, 3 do
            assert.is_nil(caption(room, "a1", "m-" .. index, "line " .. index))
        end
        destroy(room)
        local payload = body(world.requests[1])
        assert.is_true(payload.truncated)
        assert.equal(2, payload.line_count)

        load({ max_lines = 1 })
        room = create_room(nil, true, "m-exact-lines")
        assert.is_nil(caption(room, "a1", "m-1", "line"))
        destroy(room)
        payload = body(world.requests[1])
        assert.is_true(payload.truncated)
        assert.equal(1, payload.line_count)

        load({ max_text_bytes = 10 })
        room = create_room(nil, true, "m-bytes")
        caption(room, "a1", "m-1", "123456")
        assert.is_nil(caption(room, "a1", "m-2", "123456"))
        caption(room, "a1", "m-3", "1")
        destroy(room)
        payload = body(world.requests[1])
        assert.is_true(payload.truncated)
        assert.equal(1, payload.line_count)
    end)

    it("cuts a line to 16000 characters on a character boundary", function()
        local room = create_room()
        caption(room, "a1", "m-1", string.rep("আ", 16001))
        destroy(room)
        local text = body(world.requests[1]).lines[1].text
        assert.equal(16000, utf8.len(text))
    end)

    it("writes the spool file privately and atomically, then deletes it on 2xx", function()
        local opened = {}
        local real_open = io.open
        io.open = function(path, mode) -- luacheck: ignore 122
            if path:find(dir, 1, true) then opened[#opened + 1] = { path = path, umask = umask } end
            return real_open(path, mode)
        end
        local ok, err = pcall(function()
            local room = create_room()
            caption(room, "a1", "m-1", "hello")
            destroy(room)
        end)
        io.open = real_open -- luacheck: ignore 122
        assert(ok, err)

        assert.equal(dir .. "/4e6c0f6c-2d8b-4c55-9a8e-1f3f0d6f9b21.json.tmp", opened[1].path)
        assert.equal("077", opened[1].umask)
        assert.equal("022", umask)
        assert.same({ "4e6c0f6c-2d8b-4c55-9a8e-1f3f0d6f9b21.json" }, files())

        world.requests[1].callback("", 204)
        assert.same({}, files())
        assert.equal(1, #world.requests)
        assert.truthy(world.logs[#world.logs].message:find("transcript delivered", 1, true))
    end)

    it("retries network errors, timeouts, 5xx, 401 and 429 on the backoff schedule", function()
        local room = create_room()
        caption(room, "a1", "m-1", "hello")
        destroy(room)

        local schedule = { 30, 60, 120, 300, 600, 1800, 3600, 3600 }
        local codes = { 0, 503, 401, 429, 403, 408, 500, 502 }
        for index, code in ipairs(codes) do
            world.requests[index].callback("", code)
            local retries = timers_with(schedule[index])
            assert.equal(1, #retries, "retry after code " .. code)
            world.timers = {}
            retries[1].callback()
            assert.equal(index + 1, #world.requests)
        end
        assert.equal(1, #files())

        -- A request that never answers is cut off after api_timeout and retried.
        local timeout = timers_with(10)
        assert.equal(1, #timeout)
        world.timers = {}
        timeout[1].callback()
        assert.is_true(world.requests[#world.requests].destroyed)
        assert.equal(1, #timers_with(3600))
        world.requests[#world.requests].callback("", 200) -- late answer after the timeout is ignored
        assert.equal(1, #files())
    end)

    it("keeps rejected transcripts as .rejected without retrying", function()
        for _, code in ipairs({ 400, 404, 409, 413, 422 }) do
            load()
            local room = create_room(nil, true, "m-" .. code)
            caption(room, "a1", "m-1", "hello")
            destroy(room)
            world.timers = {}
            world.requests[1].callback("", code)
            assert.same({}, timers_with(30))
            assert.same({ "m-" .. code .. ".rejected" }, files())
            os.remove(dir .. "/m-" .. code .. ".rejected")
        end
    end)

    it("keeps a transcript as .failed once the retry window is over", function()
        load({ retry_hours = 0 })
        local room = create_room()
        caption(room, "a1", "m-1", "hello")
        destroy(room)
        world.timers = {}
        world.requests[1].callback("", 503)
        assert.same({}, timers_with(30))
        assert.same({ "4e6c0f6c-2d8b-4c55-9a8e-1f3f0d6f9b21.failed" }, files())
    end)

    it("resumes pending transcripts on load and drops unfinished writes", function()
        local long_ago = os.time() - 2 * 86400
        write("pending-1.json", '{"key":"pending-1"}')
        write("stale.json", '{"key":"stale"}', long_ago)
        write("half.json.tmp", "{")
        load()

        assert.equal(2, #world.requests)
        assert.equal('{"key":"pending-1"}', world.requests[1].options.body)
        assert.equal("Bearer secret", world.requests[1].options.headers.Authorization)
        assert.same({ "pending-1.json", "stale.json" }, files())

        world.requests[1].callback("", 503)
        assert.equal(1, #timers_with(30))
        world.requests[2].callback("", 503) -- older than the retry window: one more try, then kept
        assert.same({ "pending-1.json", "stale.failed" }, files())
    end)

    it("purges .failed and .rejected files after the retry window plus the keep days", function()
        local expired = os.time() - 24 * 3600 - 7 * 86400 - 60
        write("old.failed", "{}", expired)
        write("old.rejected", "{}", expired)
        write("recent.failed", "{}", os.time() - 7 * 86400)
        load()
        assert.same({ "recent.failed" }, files())
        assert.equal(1, #timers_with(3600))
    end)

    it("falls back to a generated key when the room has no usable meeting id", function()
        local room = create_room(nil, true, "../../etc/passwd")
        caption(room, "a1", "m-1", "hello")
        destroy(room)
        assert.equal("generated-id", body(world.requests[1]).key)
        assert.same({ "generated-id.json" }, files())
    end)

    it("watches the main MUC only", function()
        assert.is_not_nil(main.hooks["jitsi-transcript-received"])
        assert.same({}, breakout.hooks)
    end)

    it("stops retrying after the module is unloaded", function()
        local room = create_room()
        caption(room, "a1", "m-1", "hello")
        destroy(room)
        world.module.unload()
        world.timers = {}
        world.requests[1].callback("", 503)
        assert.same({}, world.timers)
        assert.equal(1, #files())
    end)

    it("disables itself without api_prefix or spool_dir", function()
        load({ api_prefix = false })
        assert.is_nil(main.hooks["muc-room-created"])
        load({ spool_dir = false })
        assert.is_nil(main.hooks["muc-room-created"])
        assert.equal("error", world.logs[1].level)
    end)
end)
