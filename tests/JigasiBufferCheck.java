package org.jitsi.jigasi.transcription;

import java.util.*;
import javax.media.format.AudioFormat;

// Runs inside the built meet-jigasi image against its patched jar (tests/jigasi-patch-check.sh).
public class JigasiBufferCheck {
    private static final AudioFormat PCM16K = new AudioFormat("LINEAR", 16000.0, 16, 1,
        AudioFormat.LITTLE_ENDIAN, AudioFormat.SIGNED);
    private static final AudioFormat PCM48K = new AudioFormat("LINEAR", 48000.0, 16, 1,
        AudioFormat.LITTLE_ENDIAN, AudioFormat.SIGNED);

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    private static byte[] packet(int length, int seed) {
        byte[] bytes = new byte[length];
        for (int i = 0; i < length; i++) bytes[i] = (byte) (seed + i);
        return bytes;
    }

    public static void main(String[] args) {
        List<byte[]> sent = new ArrayList<>();

        check(ParticipantAudioBuffer.capacity(PCM16K, 640, 100) == 3200, "16 kHz mono: 100 ms is 3200 bytes");
        check(ParticipantAudioBuffer.capacity(PCM48K, 1920, 100) == 9600, "48 kHz mono: 100 ms is 9600 bytes");
        check(ParticipantAudioBuffer.capacity(null, 640, 100) == 3200, "unknown format: sized from a 20 ms packet");

        ParticipantAudioBuffer buffer = new ParticipantAudioBuffer(100, sent::add);
        byte[] expected = new byte[3200];
        for (int i = 0; i < 5; i++) {
            byte[] p = packet(640, i * 7);
            System.arraycopy(p, 0, expected, i * 640, 640);
            buffer.add(PCM16K, p);
            if (i < 4) check(sent.isEmpty(), "nothing sent before 100 ms");
            Arrays.fill(p, (byte) 0x55); // the caller reusing its array must not change buffered audio
        }
        check(sent.size() == 1 && Arrays.equals(sent.get(0), expected), "exactly the 100 ms written, in order");
        byte[] first = sent.get(0).clone();

        buffer.add(PCM16K, packet(640, 1));
        buffer.add(PCM16K, packet(640, 2));
        check(Arrays.equals(sent.get(0), first), "sent audio is a copy, not the reused backing array");
        buffer.flush();
        check(sent.size() == 2 && sent.get(1).length == 1280, "flush sends only the 40 ms written since the last send");
        buffer.flush();
        check(sent.size() == 2, "a second flush sends no stale audio");

        buffer.add(PCM16K, packet(640, 3));
        buffer.add(PCM16K, packet(4000, 4));
        check(sent.size() == 4 && sent.get(2).length == 640 && sent.get(3).length == 4000,
            "an oversized packet sends what is pending first, then itself");

        buffer.add(PCM16K, packet(640, 5));
        buffer.clear();
        buffer.flush();
        check(sent.size() == 4, "clear drops pending audio");

        List<byte[]> direct = new ArrayList<>();
        ParticipantAudioBuffer passthrough = new ParticipantAudioBuffer(0, direct::add);
        byte[] p = packet(640, 9);
        passthrough.add(PCM16K, p);
        check(direct.size() == 1 && direct.get(0) != p && Arrays.equals(direct.get(0), p), "0 ms sends each packet as a copy");

        check(new ParticipantAudioBuffer(-5, b -> {}).getBufferMs() == 0, "negative clamps to 0");
        check(new ParticipantAudioBuffer(60000, b -> {}).getBufferMs() == ParticipantAudioBuffer.MAX_BUFFER_MS,
            "large values clamp");
        check(ParticipantAudioBuffer.DEFAULT_BUFFER_MS == 100, "default is 100 ms");
        System.out.println("patched Jigasi audio buffer: ok");
    }
}
