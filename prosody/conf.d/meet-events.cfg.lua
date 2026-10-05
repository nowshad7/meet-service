local function setting(name, default)
    local value = Lua.os.getenv(name)
    if value == nil or value == "" then
        return default
    end
    return value
end

if setting("MEET_EVENTS") == "1" then
    local domain = setting("XMPP_DOMAIN", "meet.jitsi")

    Component ("events." .. domain) "meet_events"
        muc_component = setting("XMPP_MUC_DOMAIN", "muc." .. domain)
        breakout_component = "breakout." .. domain
        muc_mapper_domain_base = domain
        api_prefix = setting("MEET_APP_API_URL")
        api_headers = { ["Authorization"] = "Bearer " .. setting("MEET_APP_API_TOKEN", "") }
        api_timeout = 10
        include_speaker_stats = true
        include_user_info = true
end
