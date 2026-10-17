config.disableThirdPartyRequests = true;

config.prejoinConfig = {
    enabled: true,
    hideDisplayName: false
};

config.startWithVideoMuted = false;
config.disableTileEnlargement = false;

config.resolution = 720;
config.constraints = {
    video: { height: { ideal: 720, max: 720, min: 180 } }
};

config.enableClosePage = true;

// Rooms are entered with the app's signed join links only, so Jitsi's invite
// and add-people dialogs would hand out a bare room URL that cannot join.
config.disableInviteFunctions = true;

config.localRecording = { disable: true };

// The live-caption pilot recognizes source speech only. Without language
// selection the closed captions button turns the user's own captions on and
// off directly instead of opening a dialog that offers only "Off".
if (config.transcription?.enabled) {
    config.transcription.translationEnabled = false;
    config.transcription.translationLanguages = [];
    config.transcription.translationLanguagesHead = [];
}
