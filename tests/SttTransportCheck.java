import java.net.URI;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import org.eclipse.jetty.websocket.api.Callback;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.annotations.WebSocket;
import org.eclipse.jetty.websocket.api.annotations.OnWebSocketMessage;
import org.eclipse.jetty.websocket.client.WebSocketClient;
import org.json.simple.JSONObject;
import org.json.simple.parser.JSONParser;

// Exercises the Jetty and JSON-simple libraries shipped inside the pinned Jigasi image.
// Payload construction and result casts mirror WhisperWebsocket.java:345-407,440-448.
@WebSocket
public class SttTransportCheck {
    private final CountDownLatch received = new CountDownLatch(4);
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    private static ByteBuffer frame(String speaker, String language, int bytes) {
        ByteBuffer header = ByteBuffer.allocate(60);
        header.put((speaker + "|" + language).getBytes(java.nio.charset.StandardCharsets.UTF_8)).rewind();
        return ByteBuffer.allocate(60 + bytes).put(header).put(new byte[bytes]).rewind();
    }
    @OnWebSocketMessage
    public void onMessage(String message) {
        try {
            JSONObject result = (JSONObject) new JSONParser().parse(message);
            String type = (String) result.get("type");
            String participant = (String) result.get("participant_id");
            String text = (String) result.get("text");
            double variance = (double) result.get("variance");
            if (!(type.equals("interim") || type.equals("final")) ||
                !(participant.equals("bangla") || participant.equals("english")) ||
                text == null || !Double.isFinite(variance)) throw new AssertionError("result format");
        } catch (Throwable error) { failure.set(error); }
        received.countDown();
    }
    private static void send(Session session, ByteBuffer payload) throws Exception {
        CompletableFuture<Void> sent = new CompletableFuture<>();
        session.sendBinary(payload, Callback.from(() -> sent.complete(null), sent::completeExceptionally));
        sent.get(10, TimeUnit.SECONDS);
    }
    public static void main(String[] args) throws Exception {
        WebSocketClient client = new WebSocketClient();
        SttTransportCheck endpoint = new SttTransportCheck();
        client.start();
        try {
            Session session = client.connect(endpoint, URI.create(args[0])).get(10, TimeUnit.SECONDS);
            send(session, frame("bangla", "bn", 96000));
            send(session, frame("english", "en", 96000));
            send(session, ByteBuffer.wrap(new byte[1]));
            if (!endpoint.received.await(10, TimeUnit.SECONDS)) throw new AssertionError("missing results");
            if (endpoint.failure.get() != null) throw new AssertionError("invalid response", endpoint.failure.get());
            session.close();
            System.out.println("pinned Jigasi Jetty/JSON transport: ok (fake provider)");
        } finally { client.stop(); }
    }
}
