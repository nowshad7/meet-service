package.path = "/check/?.lua;/usr/share/lua/5.4/prosody/?.lua;/usr/share/lua/5.4/prosody/?/init.lua;" .. package.path
package.cpath = "/usr/lib/x86_64-linux-gnu/lua/5.4/prosody/?.so;" .. package.cpath
local fake = require "fake_prosody"
local lfs = require "lfs"
local json = require "util.json"
local socket_http = require "socket.http"
local ltn12 = require "ltn12"

local mode = arg[1]
assert(mode == "normal" or mode == "outage" or mode == "recovery" or mode == "save-off", "unknown mode")
local spool_dir = "/var/lib/prosody/meet-transcripts"
local options = {
    muc_component = "muc.meet.jitsi",
    api_prefix = "http://app:3000/meet/api",
    api_headers = { Authorization = "Bearer transcripts-e2e-secret" },
    api_timeout = 5,
    spool_dir = spool_dir,
}
local world = fake.new({ host = "transcripts.meet.jitsi", options = options })
world.requires["util.json"] = json
world.requires["util.pposix"] = require "util.pposix"
world.requires["util.uuid"] = { generate = function() return "generated-e2e-id" end }
world.requires["util.time"] = { now = os.time }
world.requires["lfs"] = lfs
world.requires["net.http"] = {
    request = function(url, request_options, callback)
        local request = { url = url, options = request_options, callback = callback }
        world.requests[#world.requests + 1] = request
        local response = {}
        local headers = {}
        for key, value in pairs(request_options.headers or {}) do headers[key] = value end
        if request_options.body then headers["content-length"] = #request_options.body end
        local _, code = socket_http.request({
            url = url,
            method = request_options.method,
            headers = headers,
            source = request_options.body and ltn12.source.string(request_options.body) or nil,
            sink = ltn12.sink.table(response),
        })
        callback(table.concat(response), tonumber(code) or 0)
        return request
    end,
    destroy_request = function() end,
}

local main = world.add_component("muc.meet.jitsi")
world.add_component("breakout.meet.jitsi")
world.load("mod_meet_transcripts")

local function names()
    local found = {}
    if lfs.attributes(spool_dir, "mode") == "directory" then
        for name in lfs.dir(spool_dir) do
            if name ~= "." and name ~= ".." then found[#found + 1] = name end
        end
    end
    table.sort(found)
    return found
end

local function assert_empty_spool()
    assert(#names() == 0, "expected empty spool, found " .. table.concat(names(), ","))
end

if mode == "recovery" then
    assert(#world.requests == 1, "module load should resume the pending delivery")
    assert_empty_spool()
    print("recovery: pending transcript delivered and spool removed")
    return
end

local function fetch_caption()
    local response = {}
    local _, code = socket_http.request({
        url = "http://provider:8080/final",
        method = "GET",
        sink = ltn12.sink.table(response),
    })
    assert(tonumber(code) == 200, "fake provider did not return a final caption")
    return assert(json.decode(table.concat(response)))
end

local room = fake.room("[acme]e2e@muc.meet.jitsi")
room._data.meetingId = mode == "outage" and "e2e-outage" or (mode == "save-off" and "e2e-save-off" or "e2e-normal")
room._data.meet_transcription = true
room._data.meet_transcription_save = mode ~= "save-off"
room._data.meet_transcription_language = "bn"
main:fire("muc-room-created", { room = room })
local occupant = { nick = room.jid .. "/speaker-1", jid = "teacher@meet.jitsi/web", bare_jid = "teacher@meet.jitsi" }
main:fire("muc-occupant-joined", {
    room = room,
    occupant = occupant,
    origin = fake.session({ id = "teacher.1", name = "Teacher" }),
})
local caption = fetch_caption()
assert(main:fire("jitsi-transcript-received", {
    room = room,
    transcription = {
        message_id = caption.message_id,
        participant = { id = caption.participant_id },
        transcript = { { text = caption.text } },
        language = caption.language,
        timestamp = caption.timestamp,
    },
}) == nil, "transcript hook must not block the live caption")
main:fire("muc-room-destroyed", { room = room })

if mode == "save-off" then
    assert(#world.requests == 0, "save-off room must not POST")
    assert_empty_spool()
    print("save-off: no transcript was spooled or sent")
elseif mode == "outage" then
    assert(#world.requests == 1, "room end should make one delivery attempt")
    assert(#names() == 1 and names()[1] == "e2e-outage.json", "network failure should keep a retryable spool file")
    assert(lfs.attributes(spool_dir, "permissions") == "rwx------", "spool directory must be mode 0700")
    assert(lfs.attributes(spool_dir .. "/e2e-outage.json", "permissions") == "rw-------",
        "spool file must be mode 0600")
    local scheduled_retry = false
    for _, task in ipairs(world.timers) do
        if task.delay == 30 then scheduled_retry = true end
    end
    assert(scheduled_retry, "network failure should schedule a retry")
    print("outage: failed delivery retained for retry")
else
    if #world.requests ~= 1 then
        for _, entry in ipairs(world.logs) do print(entry.level .. ": " .. entry.message) end
    end
    assert(#world.requests == 1, "normal room should POST once")
    assert_empty_spool()
    print("normal: transcript delivered and spool removed")
end
