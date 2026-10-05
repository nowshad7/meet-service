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

config.localRecording = { disable: true };
