std = "lua54"
max_line_length = 120

files["prosody/plugins"] = {
    globals = { "module" },
    read_globals = { "prosody" },
}

files["tests"] = {
    std = "+busted",
    self = false,
}
