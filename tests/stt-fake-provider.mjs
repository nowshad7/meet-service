// Test-only provider; excluded from the gateway image.
export function createProvider() {
    return { async transcribe({ participantId, language, final }) {
        return [{ text: `${participantId}:${language}`, isFinal: final, variance: 0.5 }];
    } };
}
