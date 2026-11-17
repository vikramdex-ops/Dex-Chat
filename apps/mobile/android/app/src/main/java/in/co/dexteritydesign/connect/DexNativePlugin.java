package in.co.dexteritydesign.connect;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Native pieces the WebView cannot do: LAN discovery over UDP, WebSockets and downloads over
 * TLS pinned to the office hub's self-issued certificate, and installing a downloaded update.
 *
 * Trust model: connections to the hub accept any certificate at the TLS layer and are then
 * checked against the SHA-256 fingerprint the app pinned on first contact. For WebSockets the
 * shared session code does that check (it receives the fingerprint before sending anything);
 * for HTTP requests and downloads it is done here. Requests without a fingerprint (GitHub)
 * use normal system certificate validation.
 */
@CapacitorPlugin(name = "DexNative")
public class DexNativePlugin extends Plugin {
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();
    private final ExecutorService io = Executors.newCachedThreadPool();
    private OkHttpClient systemClient;
    private OkHttpClient hubClient;
    /** The internet gateway: ordinary certificate checks (Cloudflare's); the hub is checked inside. */
    private OkHttpClient gatewayClient;

    @Override
    public void load() {
        systemClient = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build();
        gatewayClient = systemClient.newBuilder()
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .followRedirects(false)
            .build();
        try {
            X509TrustManager acceptAll = new X509TrustManager() {
                @Override public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                @Override public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[] { acceptAll }, new SecureRandom());
            hubClient = new OkHttpClient.Builder()
                .sslSocketFactory(ctx.getSocketFactory(), acceptAll)
                .hostnameVerifier((host, session) -> true)
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .followRedirects(false)
                .build();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Same format as Node's X509Certificate.fingerprint256: upper-case hex pairs joined by ':'. */
    static String fingerprint(Certificate cert) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format("%02X", d[i]));
        }
        return sb.toString();
    }

    private static String peerFingerprint(Response res) throws Exception {
        if (res.handshake() == null || res.handshake().peerCertificates().isEmpty()) return "";
        return fingerprint(res.handshake().peerCertificates().get(0));
    }

    // ---------------------------------------------------------------- discovery
    @PluginMethod
    public void discover(PluginCall call) {
        final int port = call.getInt("port", 47901);
        final int timeoutMs = call.getInt("timeoutMs", 1500);
        final byte[] probe = call.getString("probe", "").getBytes(StandardCharsets.UTF_8);
        io.execute(() -> {
            JSArray hubs = new JSArray();
            try (DatagramSocket sock = new DatagramSocket()) {
                sock.setBroadcast(true);
                sock.setSoTimeout(250);
                Set<InetAddress> targets = new LinkedHashSet<>();
                targets.add(InetAddress.getByName("255.255.255.255"));
                for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                    if (!ni.isUp() || ni.isLoopback()) continue;
                    for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                        if (ia.getBroadcast() != null) targets.add(ia.getBroadcast());
                    }
                }
                for (InetAddress t : targets) {
                    try { sock.send(new DatagramPacket(probe, probe.length, t, port)); } catch (Exception ignored) { }
                }
                long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[2048];
                Set<String> seen = new LinkedHashSet<>();
                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try { sock.receive(p); } catch (SocketTimeoutException e) { continue; }
                    String data = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                    String address = p.getAddress().getHostAddress();
                    if (!seen.add(address + data)) continue;
                    JSObject h = new JSObject();
                    h.put("address", address);
                    h.put("data", data);
                    hubs.put(h);
                }
                JSObject ret = new JSObject();
                ret.put("hubs", hubs);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Discovery failed: " + e.getMessage());
            }
        });
    }

    // ---------------------------------------------------------------- websockets
    @PluginMethod
    public void wsOpen(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        if (id == null || url == null) { call.reject("id and url are required"); return; }
        Request req = new Request.Builder().url(url).build();
        WebSocket ws = hubClient.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                JSObject e = new JSObject();
                e.put("id", id);
                try { e.put("fingerprint", peerFingerprint(response)); } catch (Exception ex) { e.put("fingerprint", ""); }
                notifyListeners("wsOpen", e);
            }
            @Override public void onMessage(WebSocket socket, String text) {
                JSObject e = new JSObject();
                e.put("id", id);
                e.put("data", text);
                notifyListeners("wsMessage", e);
            }
            @Override public void onClosed(WebSocket socket, int code, String reason) { closed(id, reason == null || reason.isEmpty() ? "connection closed" : reason); }
            @Override public void onFailure(WebSocket socket, Throwable t, Response response) { closed(id, t.getMessage() == null ? "connection failed" : t.getMessage()); }
        });
        sockets.put(id, ws);
        call.resolve();
    }

    /** A binary WebSocket to the internet gateway; frames cross the bridge as base64. */
    @PluginMethod
    public void gwOpen(PluginCall call) {
        final String id = call.getString("id");
        final String url = call.getString("url");
        if (id == null || url == null || !(url.startsWith("wss://") || url.startsWith("ws://127.0.0.1"))) { call.reject("A secure gateway address is required"); return; }
        Request req = new Request.Builder().url(url).build();
        WebSocket ws = gatewayClient.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) {
                JSObject e = new JSObject();
                e.put("id", id);
                notifyListeners("gwOpen", e);
            }
            @Override public void onMessage(WebSocket socket, okio.ByteString bytes) {
                JSObject e = new JSObject();
                e.put("id", id);
                e.put("data", bytes.base64());
                notifyListeners("gwBinary", e);
            }
            @Override public void onClosing(WebSocket socket, int code, String reason) { socket.close(1000, null); }
            @Override public void onClosed(WebSocket socket, int code, String reason) { closed(id, reason == null || reason.isEmpty() ? "connection closed" : reason); }
            @Override public void onFailure(WebSocket socket, Throwable t, Response response) { closed(id, t.getMessage() == null ? "connection failed" : t.getMessage()); }
        });
        sockets.put(id, ws);
        call.resolve();
    }

    @PluginMethod
    public void gwSend(PluginCall call) {
        WebSocket ws = sockets.get(call.getString("id", ""));
        if (ws != null) {
            okio.ByteString b = okio.ByteString.decodeBase64(call.getString("data", ""));
            if (b != null) ws.send(b);
        }
        call.resolve();
    }

    /** Append base64 bytes to a file in the file cache (downloads through the gateway). */
    @PluginMethod
    public void fileWrite(PluginCall call) {
        final String id = call.getString("id", "");
        final String name = safeName(call.getString("name"));
        final String data = call.getString("data", "");
        final boolean done = Boolean.TRUE.equals(call.getBoolean("done", false));
        final boolean first = Boolean.TRUE.equals(call.getBoolean("first", false));
        if (!id.matches("[0-9A-Z]{26}")) { call.reject("Invalid file"); return; }
        io.execute(() -> {
            try {
                File dir = new File(new File(getContext().getCacheDir(), "files"), id);
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create the file cache");
                File part = new File(dir, name + ".part");
                if (!data.isEmpty()) {
                    try (OutputStream out = new FileOutputStream(part, !first)) { out.write(Base64.decode(data, Base64.DEFAULT)); }
                } else if (first) {
                    new FileOutputStream(part, false).close();
                }
                if (done) {
                    File dest = new File(dir, name);
                    if (!part.renameTo(dest)) throw new Exception("Could not save the file");
                    resolvePath(call, dest);
                } else {
                    call.resolve();
                }
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Could not save the file" : e.getMessage());
            }
        });
    }

    private void closed(String id, String reason) {
        if (sockets.remove(id) == null) return;
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("reason", reason);
        notifyListeners("wsClose", e);
    }

    @PluginMethod
    public void wsSend(PluginCall call) {
        WebSocket ws = sockets.get(call.getString("id", ""));
        if (ws != null) ws.send(call.getString("data", ""));
        call.resolve();
    }

    @PluginMethod
    public void wsClose(PluginCall call) {
        WebSocket ws = sockets.remove(call.getString("id", ""));
        if (ws != null) ws.cancel();
        call.resolve();
    }

    // ---------------------------------------------------------------- http (hub feed)
    @PluginMethod
    public void httpGet(PluginCall call) {
        final String url = call.getString("url");
        final String fp = call.getString("fingerprint");
        io.execute(() -> {
            try (Response res = (fp != null ? hubClient : systemClient).newCall(new Request.Builder().url(url).build()).execute()) {
                if (fp != null && !fp.equals(peerFingerprint(res))) { call.reject("The hub presented an unexpected certificate."); return; }
                String body = res.body() != null ? res.body().string() : "";
                if (body.length() > 512 * 1024) { call.reject("Response too large"); return; }
                JSObject ret = new JSObject();
                ret.put("status", res.code());
                ret.put("body", body);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Request failed" : e.getMessage());
            }
        });
    }

    // ---------------------------------------------------------------- updates
    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String fp = call.getString("fingerprint");
        final String name = call.getString("file", "");
        final long size = call.getLong("size", 0L);
        final String sha512 = call.getString("sha512", "");
        if (url == null || !name.matches("[\\w.\\-]+") || size <= 0) { call.reject("Invalid download request"); return; }
        io.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create the update folder");
                File dest = new File(dir, name);
                File part = new File(dir, name + ".part");
                if (dest.exists() && dest.length() == size && sha512.equals(sha512Of(dest))) { resolvePath(call, dest); return; }
                // keep only the file being downloaded
                File[] old = dir.listFiles();
                if (old != null) for (File f : old) if (!f.getName().equals(part.getName())) f.delete();
                if (getContext().getCacheDir().getUsableSpace() < size + 50L * 1024 * 1024) throw new Exception("Not enough free storage for the update.");

                long offset = part.exists() ? part.length() : 0;
                if (offset >= size) { part.delete(); offset = 0; }
                Request.Builder rb = new Request.Builder().url(url);
                if (offset > 0) rb.header("Range", "bytes=" + offset + "-");
                try (Response res = (fp != null ? hubClient : systemClient).newCall(rb.build()).execute()) {
                    if (fp != null && !fp.equals(peerFingerprint(res))) throw new Exception("The hub presented an unexpected certificate.");
                    if (!res.isSuccessful()) throw new Exception("Download failed (HTTP " + res.code() + ")");
                    boolean append = offset > 0 && res.code() == 206;
                    long received = append ? offset : 0;
                    long lastNotify = 0;
                    try (InputStream in = res.body().byteStream(); OutputStream out = new FileOutputStream(part, append)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            received += n;
                            if (received > size) throw new Exception("The download is larger than expected.");
                            out.write(buf, 0, n);
                            long now = System.currentTimeMillis();
                            if (now - lastNotify > 250) { lastNotify = now; progress(received, size); }
                        }
                    }
                    progress(received, size);
                }
                if (part.length() != size) throw new Exception("The download was incomplete; it will resume.");
                if (!sha512.equals(sha512Of(part))) { part.delete(); throw new Exception("The downloaded update failed its integrity check and was discarded."); }
                if (!part.renameTo(dest)) throw new Exception("Could not finish saving the update.");
                resolvePath(call, dest);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage());
            }
        });
    }

    private void progress(long received, long total) {
        JSObject e = new JSObject();
        e.put("received", received);
        e.put("total", total);
        notifyListeners("downloadProgress", e);
    }

    private static void resolvePath(PluginCall call, File f) {
        JSObject ret = new JSObject();
        ret.put("path", f.getAbsolutePath());
        call.resolve(ret);
    }

    private static String sha512Of(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-512");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        return Base64.encodeToString(md.digest(), Base64.NO_WRAP);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        File file = path == null ? null : new File(path);
        File updates = new File(getContext().getCacheDir(), "updates");
        if (file == null || !file.exists() || !updates.equals(file.getParentFile())) { call.reject("The update file is missing."); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent allow = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            allow.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(allow);
            call.reject("Allow Dexterity Connect to install updates, then tap Restart to update again.");
            return;
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    // ---------------------------------------------------------------- conversation files
    private static String safeName(String n) {
        String s = n == null ? "file" : n.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        if (s.isEmpty()) s = "file";
        return s.length() > 150 ? s.substring(0, 150) : s;
    }

    /** Download a file from the hub once (pinned, with the session's file token); returns its path. */
    @PluginMethod
    public void fileGet(PluginCall call) {
        final String url = call.getString("url");
        final String fp = call.getString("fingerprint");
        final String token = call.getString("token", "");
        final String id = call.getString("id", "");
        final String name = safeName(call.getString("name"));
        if (url == null || fp == null || !id.matches("[0-9A-Z]{26}")) { call.reject("Invalid file request"); return; }
        io.execute(() -> {
            try {
                File dir = new File(new File(getContext().getCacheDir(), "files"), id);
                File dest = new File(dir, name);
                if (dest.exists() && dest.length() > 0) { resolvePath(call, dest); return; }
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create the file cache");
                File part = new File(dir, name + ".part");
                Request req = new Request.Builder().url(url).header("Authorization", "Bearer " + token).build();
                try (Response res = hubClient.newCall(req).execute()) {
                    if (!fp.equals(peerFingerprint(res))) throw new Exception("The hub presented an unexpected certificate.");
                    if (!res.isSuccessful()) throw new Exception(res.code() == 404 ? "This file is no longer available." : "Download failed (HTTP " + res.code() + ")");
                    try (InputStream in = res.body().byteStream(); OutputStream out = new FileOutputStream(part)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    }
                }
                if (!part.renameTo(dest)) throw new Exception("Could not save the file");
                resolvePath(call, dest);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage());
            }
        });
    }

    /** Upload bytes (base64) to the hub's /files endpoint; resolves with the hub's JSON reply. */
    @PluginMethod
    public void fileUpload(PluginCall call) {
        final String url = call.getString("url");
        final String fp = call.getString("fingerprint");
        final String token = call.getString("token", "");
        final String data = call.getString("data", "");
        if (url == null || fp == null) { call.reject("Invalid upload"); return; }
        io.execute(() -> {
            try {
                byte[] bytes = Base64.decode(data, Base64.DEFAULT);
                okhttp3.RequestBody body = okhttp3.RequestBody.create(bytes, okhttp3.MediaType.parse("application/octet-stream"));
                Request req = new Request.Builder().url(url).post(body).header("Authorization", "Bearer " + token).build();
                try (Response res = hubClient.newCall(req).execute()) {
                    if (!fp.equals(peerFingerprint(res))) throw new Exception("The hub presented an unexpected certificate.");
                    String text = res.body() != null ? res.body().string() : "";
                    JSObject ret = new JSObject();
                    ret.put("status", res.code());
                    ret.put("body", text);
                    call.resolve(ret);
                }
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Upload failed" : e.getMessage());
            }
        });
    }

    /** Read part of a cached file as base64 (to decrypt an end-to-end encrypted attachment). */
    @PluginMethod
    public void fileRead(PluginCall call) {
        final File f = cachedFile(call.getString("path"));
        final long offset = call.getLong("offset", 0L);
        final int length = Math.max(1, Math.min(call.getInt("length", 512 * 1024), 2 * 1024 * 1024));
        if (f == null || offset < 0) { call.reject("The file is missing."); return; }
        io.execute(() -> {
            try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "r")) {
                long size = raf.length();
                byte[] buf = new byte[(int) Math.max(0, Math.min(length, size - offset))];
                if (buf.length > 0) { raf.seek(offset); raf.readFully(buf); }
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
                ret.put("eof", offset + buf.length >= size);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Could not read the file" : e.getMessage());
            }
        });
    }

    /** Remove a cached file (the ciphertext once an attachment is decrypted, or a damaged one). */
    @PluginMethod
    public void fileDelete(PluginCall call) {
        File f = cachedFile(call.getString("path"));
        if (f != null && !f.delete()) f.deleteOnExit();
        call.resolve();
    }

    private File cachedFile(String path) {
        File f = path == null ? null : new File(path);
        File files = new File(getContext().getCacheDir(), "files");
        if (f == null || !f.exists()) return null;
        try { return f.getCanonicalPath().startsWith(files.getCanonicalPath() + File.separator) ? f : null; } catch (Exception e) { return null; }
    }

    /** Open a downloaded file in another app (PDF viewer, gallery, Office…). */
    @PluginMethod
    public void openFile(PluginCall call) {
        File f = cachedFile(call.getString("path"));
        String mime = call.getString("mime", "*/*");
        if (f == null) { call.reject("The file is missing."); return; }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, mime);
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (Exception e) {
            call.reject("No app on this phone can open this kind of file.");
        }
    }

    /** Copy a downloaded file into the phone's Downloads folder. */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        File f = cachedFile(call.getString("path"));
        String name = safeName(call.getString("name"));
        String mime = call.getString("mime", "application/octet-stream");
        if (f == null) { call.reject("The file is missing."); return; }
        io.execute(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(android.provider.MediaStore.Downloads.MIME_TYPE, mime);
                    v.put(android.provider.MediaStore.Downloads.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS + "/Dexterity Connect");
                    Uri dest = getContext().getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (dest == null) throw new Exception("Could not save to Downloads");
                    try (InputStream in = new FileInputStream(f); OutputStream out = getContext().getContentResolver().openOutputStream(dest)) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    }
                } else {
                    File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "Dexterity Connect");
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("Could not save to Downloads");
                    try (InputStream in = new FileInputStream(f); OutputStream out = new FileOutputStream(new File(dir, name))) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("path", "Downloads/Dexterity Connect/" + name);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Could not save the file" : e.getMessage());
            }
        });
    }

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("model", Build.MODEL);
        ret.put("manufacturer", Build.MANUFACTURER);
        ret.put("androidVersion", Build.VERSION.RELEASE);
        try {
            ret.put("appVersion", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (Exception e) {
            ret.put("appVersion", "0.0.0");
        }
        call.resolve(ret);
    }

    // ---------------------------------------------------------------- notifications
    private String launchLink = null;

    /** A message, reminder or meeting notification; tapping it opens the given dexconnect:// link. */
    @PluginMethod
    public void showNotification(PluginCall call) {
        Notifier.show(getContext(), call.getString("title", "Dexterity Connect"), call.getString("body", ""),
            call.getString("link", "dexconnect://open"), Boolean.TRUE.equals(call.getBoolean("silent", false)));
        call.resolve();
    }

    /** Stay connected in the background (a quiet ongoing notification) or stop doing so. */
    @PluginMethod
    public void keepAlive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        // remembered for restarts after a reboot or an update (BootReceiver)
        HubService.prefs(getContext()).edit().putBoolean("keepAlive", on).apply();
        if (on) HubService.start(getContext(), call.getString("text", "Connected to the office"));
        else {
            try { getContext().stopService(new Intent(getContext(), HubService.class)); } catch (Exception ignored) { }
        }
        call.resolve();
    }

    /**
     * What the background service needs to wait for messages on its own: the hub's address and
     * certificate, a per-device token (kept wrapped by the Keystore), where it left off, and the
     * person's notification preferences. With on=false it stops waiting.
     */
    @PluginMethod
    public void watchConfig(PluginCall call) {
        android.content.SharedPreferences.Editor ed = HubService.prefs(getContext()).edit();
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        String url = call.getString("url");
        String fp = call.getString("fingerprint");
        String token = call.getString("token");
        try {
            if (on && url != null && url.startsWith("https://") && fp != null && token != null) {
                SecureStore.set(getContext(), "notify-token", token);
                ed.putString("url", url).putString("fp", fp);
            } else if (!on) {
                SecureStore.set(getContext(), "notify-token", null);
                ed.remove("url").remove("fp");
            }
        } catch (Exception e) {
            call.reject("Could not keep the background sign-in on this phone.");
            return;
        }
        ed.putBoolean("on", on)
            .putString("notifyFor", call.getString("notifyFor", "all"))
            .putBoolean("showPreviews", !Boolean.FALSE.equals(call.getBoolean("showPreviews", true)))
            .putBoolean("silent", Boolean.TRUE.equals(call.getBoolean("silent", false)));
        String qf = call.getString("quietFrom");
        String qt = call.getString("quietTo");
        if (qf != null && qt != null) ed.putString("quietFrom", qf).putString("quietTo", qt); else ed.remove("quietFrom").remove("quietTo");
        ed.apply();
        HubService.poke();
        call.resolve();
    }

    /** The app's own connection is up or down; while it is up, the service does not wait separately. */
    @PluginMethod
    public void setConnected(PluginCall call) {
        HubService.appConnected = Boolean.TRUE.equals(call.getBoolean("connected", false));
        String cursor = call.getString("cursor");
        if (cursor != null && cursor.matches("[0-9A-Z]{26}")) {
            android.content.SharedPreferences p = HubService.prefs(getContext());
            // only forwards: ids sort by time
            if (cursor.compareTo(p.getString("cursor", "")) > 0) p.edit().putString("cursor", cursor).apply();
        }
        HubService.poke();
        call.resolve();
    }

    /** Where the background service left off (the newest message it has shown or skipped). */
    @PluginMethod
    public void watchCursor(PluginCall call) {
        JSObject ret = new JSObject();
        String c = HubService.prefs(getContext()).getString("cursor", null);
        ret.put("cursor", c == null || c.isEmpty() ? null : c);
        call.resolve(ret);
    }

    /** Everything that decides whether notifications keep arriving, for the Notifications check. */
    @PluginMethod
    public void notifyHealth(PluginCall call) {
        android.content.Context ctx = getContext();
        JSObject ret = new JSObject();
        ret.put("notifications", Notifier.allowed(ctx) && !Notifier.messagesBlocked(ctx));
        ret.put("batteryExempt", DeviceHealth.batteryExempt(ctx));
        ret.put("backgroundRestricted", DeviceHealth.backgroundRestricted(ctx));
        ret.put("maker", DeviceHealth.maker());
        ret.put("manufacturer", Build.MANUFACTURER);
        ret.put("model", Build.MODEL);
        ret.put("androidVersion", Build.VERSION.RELEASE);
        ret.put("autostartPage", DeviceHealth.autostartIntent(ctx) != null);
        ret.put("keepAlive", HubService.prefs(ctx).getBoolean("keepAlive", false));
        ret.put("serviceRunning", HubService.running);
        ret.put("watching", HubService.prefs(ctx).getBoolean("on", false));
        ret.put("lastOk", HubService.lastOk == 0 ? null : HubService.lastOk);
        ret.put("lastError", HubService.lastError);
        call.resolve(ret);
    }

    /** Open a settings page: notifications, battery, autostart (the maker's page) or the app's page. */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String target = call.getString("target", "app");
        String opened = DeviceHealth.open(getContext(), target);
        JSObject ret = new JSObject();
        ret.put("opened", opened);
        call.resolve(ret);
    }

    /** Android's own question about running in the background (asked after the app explains why). */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        String opened = DeviceHealth.batteryExempt(getContext()) ? "already" : DeviceHealth.open(getContext(), "battery");
        JSObject ret = new JSObject();
        ret.put("opened", opened);
        call.resolve(ret);
    }

    // ---------------------------------------------------------------- device keys
    /** A secret wrapped by the Android Keystore (rejects with code "unreadable" when it can no longer be opened). */
    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = call.getString("key");
        if (!SecureStore.validName(key)) { call.reject("Invalid key name"); return; }
        try {
            JSObject ret = new JSObject();
            ret.put("value", SecureStore.get(getContext(), key));
            call.resolve(ret);
        } catch (SecureStore.UnreadableException e) {
            call.reject(e.getMessage(), "unreadable");
        } catch (Exception e) {
            call.reject("The Android Keystore is not available.", "unavailable");
        }
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (!SecureStore.validName(key) || value == null || value.length() > 16_000) { call.reject("Invalid key or value"); return; }
        try {
            SecureStore.set(getContext(), key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject("The Android Keystore is not available.", "unavailable");
        }
    }

    /** Ask for permission to show notifications (Android 13 and newer). */
    @PluginMethod
    public void askNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null
            && ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 4702);
        }
        call.resolve();
    }

    /** The dexconnect:// link the app was opened with (a tapped notification), once. */
    /** The clipboard's text, so a pairing code copied on the download page is found on first launch. */
    @PluginMethod
    public void clipboardText(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            android.content.ClipboardManager cm = (android.content.ClipboardManager) getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            String text = null;
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(getContext());
                if (t != null && t.length() <= 4000) text = t.toString();
            }
            ret.put("text", text);
        } catch (Exception e) {
            ret.put("text", (String) null);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void takeLaunchLink(PluginCall call) {
        if (launchLink == null && getActivity() != null) {
            Intent i = getActivity().getIntent();
            if (i != null && i.getData() != null && "dexconnect".equals(i.getData().getScheme())) launchLink = i.getData().toString();
            if (i != null) i.setData(null);
        }
        JSObject ret = new JSObject();
        ret.put("url", launchLink);
        launchLink = null;
        call.resolve(ret);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && intent.getData() != null && "dexconnect".equals(intent.getData().getScheme())) {
            JSObject ev = new JSObject();
            ev.put("url", intent.getData().toString());
            notifyListeners("deepLink", ev, true);
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (WebSocket ws : sockets.values()) ws.cancel();
        sockets.clear();
        io.shutdownNow();
    }
}
