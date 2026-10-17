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
    expect(config.get("*", "meet_privacy_av_moderation"), false, "privacy media switch")
    expect(config.get("events.example.org", "component_module"), "meet_events", "events component")
    expect(config.get("events.example.org", "muc_component"), "muc.example.org", "events muc")
    expect(config.get("events.example.org", "breakout_component"), "breakout.example.org", "events breakout")
    expect(config.get("events.example.org", "api_prefix"), "http://app.internal/meet/api", "events api")
    expect(config.get("events.example.org", "api_headers").Authorization, "Bearer test-token", "events header")
    expect(config.get("transcripts.example.org", "component_module"), "meet_transcripts", "transcripts component")
    expect(config.get("transcripts.example.org", "muc_component"), "muc.example.org", "transcripts muc")
    expect(config.get("transcripts.example.org", "api_prefix"), "http://app.internal/meet/api", "transcripts api")
    expect(config.get("transcripts.example.org", "api_headers").Authorization, "Bearer test-token",
        "transcripts header")
    expect(config.get("transcripts.example.org", "spool_dir"), "/var/lib/prosody/meet-transcripts", "spool")
    expect(config.get("transcripts.example.org", "retry_hours"), 12, "transcripts retry window")
    expect(config.get("transcripts.example.org", "keep_days"), 3, "transcripts keep days")
elseif os.getenv("CHECK_CASE") == "transcripts-default" then
    expect(config.get("transcripts.meet.jitsi", "component_module"), "meet_transcripts", "transcripts component")
    expect(config.get("transcripts.meet.jitsi", "muc_component"), "muc.meet.jitsi", "transcripts muc")
    expect(config.get("transcripts.meet.jitsi", "retry_hours"), 24, "transcripts retry default")
    expect(config.get("transcripts.meet.jitsi", "keep_days"), 7, "transcripts keep default")
    expect(config.get("events.meet.jitsi", "component_module"), nil, "events component")
else
    expect(config.get("*", "meet_transcription_enabled"), false, "transcription default")
    expect(config.get("*", "reservations_api_headers"), nil, "room gate header")
    expect(config.get("*", "prosody_password_public_key_repo_url"), nil, "control keys")
    expect(config.get("*", "meet_control_removed_notice"), nil, "removed notice")
    expect(config.get("*", "meet_privacy_av_moderation"), true, "privacy media default")
    expect(config.get("events.meet.jitsi", "component_module"), nil, "events component")
    expect(config.get("transcripts.meet.jitsi", "component_module"), nil, "transcripts component")
end

print("prosody config " .. os.getenv("CHECK_CASE") .. ": ok")
