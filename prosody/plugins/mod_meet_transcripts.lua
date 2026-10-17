--- Component that saves a room's final captions and POSTs them to the app once the room ends.
--  Configured by prosody/conf.d/meet-transcripts.cfg.lua; the options are:
--
--    Component "transcripts.meet.jitsi" "meet_transcripts"
--        muc_component = "muc.meet.jitsi"
--        api_prefix = "http://app.internal/meet/api"
--        api_headers = { ["Authorization"] = "Bearer <MEET_APP_API_TOKEN>" }
--        spool_dir = "/var/lib/prosody/meet-transcripts"
--
--        --- Optional, defaults shown
--        api_timeout = 30         -- seconds per request
--        retry_hours = 24         -- keep retrying this long after the room ended
--        keep_days = 7            -- then keep .failed and .rejected files this long
--        max_lines = 20000        -- per room; more lines set truncated
--        max_text_bytes = 4194304 -- per room; more text sets truncated
--
--  Only the main MUC is watched, and only rooms that mod_meet_transcription entitled to
--  captions with context.room.transcription.save from the first token. Caption text is
--  never logged.

local json = require "util.json";
local jid = require "util.jid";
local http = require "net.http";
local timer = require "util.timer";
local uuid = require "util.uuid";
local time_now = require "util.time".now;
local lfs = require "lfs";
local pposix = require "util.pposix";
local util = module:require "util";
local is_healthcheck_room = util.is_healthcheck_room;

local main_muc_component_host = module:get_option_string("muc_component");
local api_prefix = module:get_option("api_prefix");
local api_headers = module:get_option("api_headers");
local api_timeout = tonumber(module:get_option("api_timeout", 30));
local spool_dir = module:get_option_string("spool_dir");
local retry_seconds = tonumber(module:get_option("retry_hours", 24)) * 3600;
local keep_seconds = tonumber(module:get_option("keep_days", 7)) * 86400;
local max_lines = tonumber(module:get_option("max_lines", 20000));
local max_text_bytes = tonumber(module:get_option("max_text_bytes", 4 * 1024 * 1024));

local MAX_LINE_CHARS = 16000;
local PURGE_INTERVAL = 3600;
-- Delay before each attempt: at once, 30 s, 1, 2, 5, 10, 30 minutes, then hourly.
local RETRY_DELAYS = { 0, 30, 60, 120, 300, 600, 1800 };
local LATER_RETRY_DELAY = 3600;
local PERMANENT_CODES = { [400] = true, [404] = true, [409] = true, [413] = true, [422] = true };

if not api_prefix then
    module:log("error", "api_prefix not specified. Disabling %s", module:get_name());
    return;
end

if not main_muc_component_host then
    module:log("error", "No muc_component specified. No muc to operate on!");
    return;
end

if not spool_dir then
    module:log("error", "spool_dir not specified. Disabling %s", module:get_name());
    return;
end

local URL_TRANSCRIPTS = api_prefix .. "/transcripts";

local http_headers = {
    ["User-Agent"] = "Prosody (" .. prosody.version .. "; " .. prosody.platform .. ")";
    ["Content-Type"] = "application/json";
};
if api_headers then
    for key, value in pairs(api_headers) do
        http_headers[key] = value;
    end
end

local unloaded = false;

local function now()
    return os.time();
end

local function spool_path(name)
    return spool_dir .. "/" .. name;
end

--- Runs fn with umask 077, so the directory is 0700 and spool files are 0600.
local function private(fn)
    local old = pposix.umask("077");
    local ok, result, err = pcall(fn);
    pposix.umask(old);
    if not ok then
        return nil, result;
    end
    return result, err;
end

local function ensure_spool_dir()
    if lfs.attributes(spool_dir, "mode") == "directory" then
        return true;
    end
    return private(function() return lfs.mkdir(spool_dir) end);
end

--- Writes the file under a temporary name and renames it, so a reader never sees half of it.
local function write_spool(name, content)
    local ok, err = ensure_spool_dir();
    if not ok then
        return nil, err;
    end
    local path, tmp = spool_path(name), spool_path(name .. ".tmp");
    return private(function()
        local file, open_err = io.open(tmp, "wb");
        if not file then
            return nil, open_err;
        end
        local written, write_err = file:write(content);
        local closed, close_err = file:close();
        if not written or not closed then
            os.remove(tmp);
            return nil, write_err or close_err;
        end
        return os.rename(tmp, path);
    end);
end

local function read_file(path)
    local file, err = io.open(path, "rb");
    if not file then
        return nil, err;
    end
    local content = file:read("a");
    file:close();
    return content;
end

--- Moves a spool file aside for manual inspection; purge() removes it later.
local function set_aside(key, suffix)
    local ok, err = os.rename(spool_path(key .. ".json"), spool_path(key .. "." .. suffix));
    if not ok then
        module:log("error", "Could not keep transcript %s as .%s: %s", key, suffix, err);
    end
end

local deliver;

--- Schedules the next attempt for a transcript after a retryable answer, or gives up.
local function retry_later(job, code)
    local at = now();
    if at >= job.deadline then
        module:log("error", "Transcript %s not delivered after %d attempts (last code %s), kept as .failed",
            job.key, job.attempt, tostring(code));
        set_aside(job.key, "failed");
        return;
    end
    local delay = RETRY_DELAYS[job.attempt + 1] or LATER_RETRY_DELAY;
    if at + delay > job.deadline then
        delay = job.deadline - at;
    end
    module:log("warn", "Transcript %s answered %s, retrying in %ds", job.key, tostring(code), delay);
    timer.add_task(delay, function()
        deliver(job);
    end);
end

local function finish(job, code)
    code = tonumber(code) or 0
    if code >= 200 and code < 300 then
        os.remove(spool_path(job.key .. ".json"));
        module:log("info", "transcript delivered: meeting_id %s, %s lines", job.key, tostring(job.line_count or "?"));
    elseif PERMANENT_CODES[code] then
        module:log("error", "Transcript %s rejected by the app with %d, kept as .rejected", job.key, code);
        set_aside(job.key, "rejected");
    elseif not unloaded then
        retry_later(job, code);
    end
end

--- POSTs one spool file. job = { key, deadline, attempt, line_count }.
function deliver(job)
    if unloaded then
        return;
    end
    local body = read_file(spool_path(job.key .. ".json"));
    if not body then
        return; -- delivered or set aside meanwhile, for example by an operator
    end
    job.attempt = job.attempt + 1;

    local completed = false;
    local request = http.request(URL_TRANSCRIPTS, {
        method = "POST";
        headers = http_headers;
        body = body;
    }, function(_, code)
        if completed then
            return;
        end
        completed = true;
        finish(job, code);
    end);

    timer.add_task(api_timeout, function()
        if completed then
            return;
        end
        completed = true;
        http.destroy_request(request);
        finish(job, 0);
    end);
end

--- Removes .failed and .rejected files once retry_hours + keep_days have passed since the room ended.
local function purge()
    if lfs.attributes(spool_dir, "mode") ~= "directory" then
        return;
    end
    local cutoff = now() - retry_seconds - keep_seconds;
    for name in lfs.dir(spool_dir) do
        if name:match("%.failed$") or name:match("%.rejected$") then
            local modified = lfs.attributes(spool_path(name), "modification");
            if modified and modified < cutoff then
                os.remove(spool_path(name));
                module:log("info", "Purged undelivered transcript %s", name);
            end
        end
    end
end

--- Picks up transcripts still waiting from before a restart or reload.
local function resume()
    if lfs.attributes(spool_dir, "mode") ~= "directory" then
        return;
    end
    local pending = {};
    for name in lfs.dir(spool_dir) do
        local key = name:match("^([%w_-]+)%.json$");
        if key then
            pending[#pending + 1] = key;
        elseif name:match("%.json%.tmp$") then
            os.remove(spool_path(name)); -- a write that never finished
        end
    end
    table.sort(pending);
    for _, key in ipairs(pending) do
        local written = lfs.attributes(spool_path(key .. ".json"), "modification") or now();
        module:log("info", "Resuming delivery of transcript %s", key);
        deliver({ key = key, deadline = written + retry_seconds, attempt = 0 });
    end
end

local function cut(text, chars)
    local length = utf8.len(text);
    if length and length > chars then
        return text:sub(1, utf8.offset(text, chars + 1) - 1);
    end
    return text;
end

local function is_system_occupant(occupant)
    local node = jid.node(occupant.jid);
    return node == "focus" or util.is_transcriber(occupant.bare_jid or jid.bare(occupant.jid));
end

local function new_transcript()
    return { lines = {}, seen = {}, speakers = {}, bytes = 0, truncated = false, created_at = now() };
end

local function room_created(event)
    local room = event.room;
    if is_healthcheck_room(room.jid) then
        return;
    end
    room.meet_transcript = new_transcript();
end

--- Captures each speaker's verified token user at join. Never removed, so late finals are attributed.
local function occupant_joined(event)
    local room, occupant = event.room, event.occupant;
    if is_healthcheck_room(room.jid) or is_system_occupant(occupant) then
        return;
    end
    local user = event.origin and event.origin.jitsi_meet_context_user;
    if type(user) ~= "table" then
        return;
    end
    local transcript = room.meet_transcript or new_transcript();
    room.meet_transcript = transcript;
    transcript.speakers[occupant.nick] = { id = user.id, name = user.name };
end

local function saving(room)
    return room._data.meet_transcription == true and room._data.meet_transcription_save == true;
end

local function transcript_received(event)
    local room, transcription = event.room, event.transcription;
    if not saving(room) or type(transcription) ~= "table" then
        return nil;
    end
    local transcript = room.meet_transcript or new_transcript();
    room.meet_transcript = transcript;

    local message_id = transcription.message_id;
    local alternative = type(transcription.transcript) == "table" and transcription.transcript[1];
    local text = type(alternative) == "table" and alternative.text;
    local participant = type(transcription.participant) == "table" and transcription.participant;
    if type(message_id) ~= "string" or type(text) ~= "string" or text == "" or not participant then
        return nil;
    end
    if transcript.seen[message_id] or transcript.truncated then
        return nil;
    end

    text = cut(text, MAX_LINE_CHARS);
    if #transcript.lines >= max_lines or transcript.bytes + #text > max_text_bytes then
        transcript.truncated = true;
        module:log("warn", "Transcript of %s reached its size cap; later captions are not saved", room.jid);
        return nil;
    end

    local speaker = transcript.speakers[room.jid .. "/" .. tostring(participant.id)] or {};
    local received_ms = math.floor(time_now() * 1000);
    transcript.seen[message_id] = true;
    transcript.bytes = transcript.bytes + #text;
    transcript.lines[#transcript.lines + 1] = {
        id = message_id;
        user_id = speaker.id;
        name = speaker.name;
        language = type(transcription.language) == "string" and transcription.language or nil;
        start_ms = tonumber(transcription.timestamp) or received_ms;
        end_ms = received_ms;
        text = text;
        order = #transcript.lines + 1;
    };
    if #transcript.lines >= max_lines or transcript.bytes >= max_text_bytes then
        transcript.truncated = true;
    end
    -- mod_muc_meeting_id returns this event's result: anything but nil would stop the caption.
    return nil;
end

local function or_null(value)
    if value == nil then
        return json.null;
    end
    return value;
end

local function build_payload(room, transcript, key)
    local lines = {};
    for index, line in ipairs(transcript.lines) do
        lines[index] = line;
    end
    table.sort(lines, function(a, b)
        if a.start_ms ~= b.start_ms then
            return a.start_ms < b.start_ms;
        end
        return a.order < b.order;
    end);
    for index, line in ipairs(lines) do
        lines[index] = {
            id = line.id;
            user_id = or_null(line.user_id);
            name = or_null(line.name);
            language = or_null(line.language);
            start_ms = line.start_ms;
            end_ms = line.end_ms;
            text = line.text;
        };
    end
    return {
        event_name = "transcript-finished";
        key = key;
        room_name = jid.node(room.jid);
        room_jid = room.jid;
        meeting_id = key;
        is_breakout = false;
        language = or_null(room._data.meet_transcription_language);
        created_at = transcript.created_at;
        destroyed_at = now();
        truncated = transcript.truncated;
        line_count = #lines;
        lines = lines;
    };
end

local function room_destroyed(event)
    local room = event.room;
    local transcript = room.meet_transcript;
    room.meet_transcript = nil;
    if not transcript or #transcript.lines == 0 or not saving(room) then
        return;
    end

    local key = room._data.meetingId;
    if type(key) ~= "string" or #key > 128 or not key:match("^[%w_-]+$") then
        key = uuid.generate();
        module:log("warn", "Room %s has no usable meeting id, saving its transcript as %s", room.jid, key);
    end

    local payload = build_payload(room, transcript, key);
    local ok, err = write_spool(key .. ".json", json.encode(payload));
    if not ok then
        module:log("error", "Could not spool transcript %s (%d lines): %s", key, payload.line_count, tostring(err));
        return;
    end
    module:log("info", "Transcript of %s spooled: meeting_id %s, %d lines%s", room.jid, key, payload.line_count,
        payload.truncated and ", truncated" or "");
    deliver({ key = key, deadline = now() + retry_seconds, attempt = 0, line_count = payload.line_count });
end

function module.unload()
    unloaded = true;
end

-- Helper function to wait till a component is loaded before running the given callback
local function run_when_component_loaded(component_host_name, callback)
    local function trigger_callback()
        module:log("info", "Component loaded %s", component_host_name);
        callback(module:context(component_host_name), component_host_name);
    end

    if prosody.hosts[component_host_name] == nil then
        module:log("debug", "Host %s not yet loaded. Will trigger when it is loaded.", component_host_name);
        prosody.events.add_handler("host-activated", function(host)
            if host == component_host_name then
                trigger_callback();
            end
        end);
    else
        trigger_callback();
    end
end

-- Helper function to wait till a component's muc module is loaded before running the given callback
local function run_when_muc_module_loaded(component_host_module, component_host_name, callback)
    local function trigger_callback()
        module:log("info", "MUC module loaded for %s", component_host_name);
        callback(prosody.hosts[component_host_name].modules.muc, component_host_module);
    end

    if prosody.hosts[component_host_name].modules.muc == nil then
        module:log("debug", "MUC module for %s not yet loaded. Will trigger when it is loaded.", component_host_name);
        prosody.hosts[component_host_name].events.add_handler("module-loaded", function(event)
            if event.module == "muc" then
                trigger_callback();
            end
        end);
    else
        trigger_callback();
    end
end

-- Main MUC only: breakout rooms are not saved.
run_when_component_loaded(main_muc_component_host, function(host_module, host_name)
    run_when_muc_module_loaded(host_module, host_name, function(_, main_module)
        main_module:hook("muc-room-created", room_created, -2);
        main_module:hook("muc-occupant-joined", occupant_joined, -2);
        main_module:hook("jitsi-transcript-received", transcript_received);
        main_module:hook("muc-room-destroyed", room_destroyed, -2);
    end);
end);

resume();
purge();
timer.add_task(PURGE_INTERVAL, function()
    if unloaded then
        return;
    end
    purge();
    return PURGE_INTERVAL;
end);
