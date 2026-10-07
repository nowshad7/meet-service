local function setting(name)
    local value = Lua.os.getenv(name)
    if value ~= nil and value ~= "" then
        return value
    end
end

local api_token = setting("MEET_APP_API_TOKEN")

if api_token then
    reservations_api_headers = { ["Authorization"] = "Bearer " .. api_token }
end

prosody_password_public_key_repo_url = setting("MEET_APP_CONTROL_KEYS_URL")

meet_control_removed_notice = setting("MEET_TEXT_REMOVED")
meet_privacy_chat_notice = setting("MEET_TEXT_PRIVATE_CHAT_ONLY")
meet_privacy_public_chat_off_notice = setting("MEET_TEXT_PUBLIC_CHAT_OFF")
meet_single_session_notice = setting("MEET_TEXT_SEAT_REPLACED")

meet_transcription_enabled = setting("MEET_TRANSCRIPTION_ENABLED") == "1"
