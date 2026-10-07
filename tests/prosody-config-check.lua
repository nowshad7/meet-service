local configmanager = require "prosody.core.configmanager"

local function load(env_description)
    local ok, err = configmanager.load("/check/prosody.cfg.lua")
    assert(ok, env_description .. ": " .. tostring(err))
    return configmanager
end

local function expect(actual, expected, what)
    if actual ~= expected then
        error(("%s: expected %s, got %s"):format(what, tostring(expected), tostring(actual)), 2)
    end
end

local config = load(os.getenv("CHECK_CASE"))

if os.getenv("CHECK_CASE") == "all-set" then
    expect(config.get("*", "meet_transcription_enabled"), true, "transcription opt-in")
    expect(config.get("*", "reservations_api_headers").Authorization, "Bearer test-token", "room gate header")
    expect(config.get("*", "prosody_password_public_key_repo_url"), "http://app.internal/control-keys", "control keys")
    expect(config.get("*", "meet_control_removed_notice"), "Removed.", "removed notice")
    expect(config.get("events.example.org", "component_module"), "meet_events", "events component")
    expect(config.get("events.example.org", "muc_component"), "muc.example.org", "events muc")
    expect(config.get("events.example.org", "breakout_component"), "breakout.example.org", "events breakout")
    expect(config.get("events.example.org", "api_prefix"), "http://app.internal/meet/api", "events api")
    expect(config.get("events.example.org", "api_headers").Authorization, "Bearer test-token", "events header")
else
    expect(config.get("*", "meet_transcription_enabled"), false, "transcription default")
    expect(config.get("*", "reservations_api_headers"), nil, "room gate header")
    expect(config.get("*", "prosody_password_public_key_repo_url"), nil, "control keys")
    expect(config.get("*", "meet_control_removed_notice"), nil, "removed notice")
    expect(config.get("events.meet.jitsi", "component_module"), nil, "events component")
end

print("prosody config " .. os.getenv("CHECK_CASE") .. ": ok")
