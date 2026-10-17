local function setting(name, default)
    local value = Lua.os.getenv(name)
    if value == nil or value == "" then
        return default
    end
    return value
end

if setting("MEET_TRANSCRIPTS") == "1" then
    local domain = setting("XMPP_DOMAIN", "meet.jitsi")

    Component ("transcripts." .. domain) "meet_transcripts"
        muc_component = setting("XMPP_MUC_DOMAIN", "muc." .. domain)
        api_prefix = setting("MEET_APP_API_URL")
        api_headers = { ["Authorization"] = "Bearer " .. setting("MEET_APP_API_TOKEN", "") }
        api_timeout = 30
        spool_dir = "/var/lib/prosody/meet-transcripts"
        retry_hours = Lua.tonumber(setting("MEET_TRANSCRIPT_RETRY_HOURS", "24"))
        keep_days = Lua.tonumber(setting("MEET_TRANSCRIPT_KEEP_DAYS", "7"))
end
