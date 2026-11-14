package in.co.dexteritydesign.connect;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;

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

    @Override
    public void load() {
        systemClient = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
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

    @Override
    protected void handleOnDestroy() {
        for (WebSocket ws : sockets.values()) ws.cancel();
        sockets.clear();
        io.shutdownNow();
    }
}
